/**
 * Accessibility (preview): one NFR card of the panel's single list. Collapsed: the NFR, its variants (lanes,
 * prevalence, mini profile) and a star. Open (in place): its whole analysis: the read controls (group, split into
 * panels, split by combination pattern, select as features), the pairs involving it (NFR pairs), its
 * sequence (copy, FASTA), the statistics, and the views (motif map, footprints, V-plots, phasing, prevalence,
 * advanced, export). A star keeps the card (name, note, colour, ticked variants) with the session; a starred card
 * of another run (another window or session) is shown with its stored numbers (StoredNfrCard).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getNfrOverview, type AccessibilityResult, type NfrProfiles, type NfrRegionResult } from '../api';
import { useContainerWidth } from '../../../hooks/useContainerWidth';
import { useBrowserStore } from '../../../stores/browserStore';
import { useAccessibilityStore } from '../accessibilityStore';
import { featureKey, useFeatureStore } from '../../../stores/featureStore';
import { bp, nfrDetectionLine, pct, strandSplit, variantColor } from '../accessibilityView';
import { cardEntry, cardKey, shownVariants, type SavedNfr } from '../savedNfrVariants';
import { copyText } from '../../../utils/clipboard';
import { downloadTextFile } from '../../../utils/analysisExport';
import { fastaFileName, fastaRecord, loadNfrSequence, sequencePart } from '../nfrSequence';
import { useJobBadges } from '../nfrJobs';
import { nfrRef, variantRef } from '../NfrFeatureTrack';
import { DisclosureChevron } from '../../../components/ui/Disclosure';
import { AnalysisButton, AnalysisStatus } from '../../../components/controls/shared';
import { NewDot } from './NfrNotices';
import { HelpTip } from './HelpTip';
import { HELP } from './nfrHelp';
import { ESTIMATORS, formatPct, formatShare } from '../../../utils/denominators';
import { NfrDetails, VariantLanes, VariantRow } from './DiscoveryOverview';
import { ReadControls, SavedNfrInspect, type SavedReadActions } from './SavedVariants';
import { NfrJobOwnerContext } from './useNfrView';

export interface CardCommon {
  actions: SavedReadActions;
  stateKeyMap: Record<string, string[]>;
  isFullView?: boolean;
  datasetLabel: (id: string) => string;
}

/** The star: kept (filled) or not; a click stars or unstars. */
function Star({ starred, onToggle, name }: { starred: boolean; onToggle: () => void; name: string }) {
  return (
    <button type="button" onClick={onToggle} data-testid="nfr-card-star" aria-pressed={starred}
      aria-label={starred ? `Unstar ${name}` : `Star ${name}`}
      title={starred ? 'Starred: kept with the session (name, note, colour, ticked variants). Click to unstar.' : 'Star: keep this NFR (with the session) and find it under Starred'}
      className={`flex-shrink-0 text-[15px] leading-none ${starred ? 'text-amber-500 hover:text-amber-600' : 'text-gray-300 hover:text-amber-500 dark:text-gray-600'}`}>
      {starred ? '★' : '☆'}
    </button>
  );
}

/**
 * Open: the card's identity row is sticky under the panel's tabs, and the card's view tabs under it (NFR-8): they need
 * its height (it wraps with the panel's width), given to the card as --nfr-card-head-h.
 */
function useStickyHead(open: boolean): [React.RefObject<HTMLDivElement>, React.CSSProperties | undefined] {
  const ref = useRef<HTMLDivElement>(null!) as React.RefObject<HTMLDivElement>;
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    setHeight(el.offsetHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);
  return [ref, open ? { '--nfr-card-head-h': `${height}px` } as React.CSSProperties : undefined];
}

function OpenToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} data-testid="nfr-card-open" aria-expanded={open}
      title={open ? 'Close the analysis' : 'Open the analysis here: motif map, footprints, V-plots, phasing, prevalence, sequence, export, and the read controls'}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-fuchsia-700 hover:bg-fuchsia-50 dark:text-fuchsia-300 dark:hover:bg-white/5">
      <DisclosureChevron open={open} /> {open ? 'Close' : 'Open'}
    </button>
  );
}

/** A card of the run the panel shows (starred or not). */
export function LiveNfrCard({ nfr, result, jobId, starred, common, classesJoined, onPairs }: {
  nfr: NfrRegionResult; result: AccessibilityResult; jobId: string; starred: SavedNfr | undefined; common: CardCommon;
  classesJoined: boolean; onPairs: (nfrId: string) => void;
}) {
  const key = cardKey(jobId, nfr.id);
  const { open, focused, unticked, setView, setLiveTicked } = useAccessibilityStore(useShallow(s => ({
    open: s.openCard === key, focused: s.focusedVariant?.card === key ? s.focusedVariant.variantId : null,
    unticked: s.untickedLive[key], setView: s.setPanelView, setLiveTicked: s.setLiveTicked,
  })));
  const entry = useMemo(() => cardEntry(jobId, result, nfr, starred, unticked), [starred, unticked, nfr, result, jobId]);
  const ticked = new Set(shownVariants(entry).map(v => v.variantId));
  const [width, measure] = useContainerWidth(320);
  const [profiles, setProfiles] = useState<NfrProfiles | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const badges = useJobBadges();
  // Features: hovering a row highlights the variant in the NFR channel above the reads and back; shift-click selects
  // it for the main toolbar's Cluster / Sort / Filter.
  const run = { jobId, result };
  const storeHover = useFeatureStore(s => s.hovered);
  const selectedFeatures = useBrowserStore(s => s.selectedFeatures);
  const selectedKeys = useMemo(() => new Set(selectedFeatures.map(featureKey)), [selectedFeatures]);
  const channelHover = storeHover?.kind === 'nfr-variant' && storeHover.source === jobId && storeHover.id.startsWith(`${nfr.id}:`)
    ? storeHover.id.slice(nfr.id.length + 1) : null;
  const nfrFeature = nfrRef(run, nfr);
  useEffect(() => {
    let live = true;
    setProfiles(null);
    if (nfr.variants.length) getNfrOverview(jobId, nfr.id).then(p => { if (live) setProfiles(p); }).catch(() => { /* the bars still show */ });
    return () => { live = false; };
  }, [jobId, nfr.id, nfr.variants.length]);
  const toggleStar = () => {
    const s = useBrowserStore.getState();
    if (starred) { s.removeSavedNfrVariant(starred.id); return; }
    const { id: _id, savedAt: _at, ...rest } = entry;
    s.addSavedNfrVariants([{ ...rest, name: nfr.id }]);
  };
  const tick = (variantId: string, on: boolean) => {
    if (starred) useBrowserStore.getState().setSavedNfrVariantShown(starred.id, variantId, on);
    else setLiveTicked(key, variantId, on);
  };
  const toggleOpen = () => setView({ openCard: open ? null : key, focusedVariant: null });
  const [headRef, headStyle] = useStickyHead(open);
  const multiChannel = nfr.variants.some(v => strandSplit(v) !== '');
  return (
    <div data-testid="nfr-card" data-nfr={nfr.id} data-card={key} data-starred={starred ? 'true' : 'false'} data-entry={starred?.id}
      data-variants={shownVariants(entry).map(v => v.name).join(',')}
      style={headStyle}
      className={`rounded-lg border bg-white/60 p-2.5 shadow-sm dark:bg-white/[0.02] ${open ? 'border-fuchsia-300 dark:border-fuchsia-800/70' : 'border-gray-200 dark:border-gray-700/80'}`}>
      {/* Open: the card's identity stays in view (under the panel's tabs) while its analysis scrolls. */}
      <div ref={headRef} className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 ${open ? 'sticky top-[var(--nfr-tabs-h,34px)] z-10 -mx-2.5 -mt-2.5 rounded-t-lg border-b border-fuchsia-100 bg-surface px-2.5 pb-1 pt-2.5 dark:border-fuchsia-900/40' : ''}`}
        data-testid="nfr-card-head" data-sticky={open || undefined}>
        <Star starred={!!starred} onToggle={toggleStar} name={nfr.id} />
        <span className={`cursor-pointer rounded px-0.5 text-[13px] font-semibold text-fuchsia-700 dark:text-fuchsia-300 ${selectedKeys.has(featureKey(nfrFeature)) ? 'ring-2 ring-gray-900 dark:ring-gray-100' : ''}`}
          data-testid="nfr-card-feature" title="Shift-click: select this NFR (Cluster in the main toolbar groups the reads by its variants)"
          onClick={e => { if (e.shiftKey || e.metaKey || e.ctrlKey) useBrowserStore.getState().selectFeature(nfrFeature, true); }}
          onMouseEnter={() => useFeatureStore.getState().setHover(nfrFeature)} onMouseLeave={() => useFeatureStore.getState().setHover(null)}>
          {nfr.id}{starred && starred.name !== nfr.id ? <span className="ml-1 font-normal text-gray-600 dark:text-gray-300">{starred.name}</span> : null}
        </span>
        {badges[`entry:${key}`] ? <NewDot /> : null}
        <span className="tabular-nums text-[12px] text-gray-800 dark:text-gray-200">{bp(nfr.start)}–{bp(nfr.end)}</span>
        <span className="inline-flex items-center text-[11px] text-gray-600 dark:text-gray-300" data-testid="nfr-card-callable">
          {nfr.callable.toLocaleString()} of {nfr.reads.toLocaleString()} reads callable<HelpTip term="callable" text={HELP.callable} testId="nfr-help-callable" />
        </span>
        {nfr.status === 'ok' && nfr.closed != null && <span className="inline-flex items-center text-[11px] text-gray-600 dark:text-gray-300">· closed {pct(nfr.closed)}<HelpTip term="closed %" text={HELP.closed} testId="nfr-help-closed" /></span>}
        {nfrDetectionLine(nfr) && (
          <span className="inline-flex items-center text-[11px] text-gray-600 dark:text-gray-300" data-testid="nfr-card-detection"
            title={nfr.detection?.fold != null ? `${nfr.detection.fold}× the background at its peak${nfr.detection.open_reads != null ? `: ${nfr.detection.open_reads.toLocaleString()} of ${(nfr.detection.peak_callable ?? 0).toLocaleString()} callable reads open` : ''}` : undefined}>
            · {nfrDetectionLine(nfr)}<HelpTip term="how it was found" text={HELP.detection} testId="nfr-help-detection" />
          </span>
        )}
        <span className="ml-auto">{nfr.variants.length > 0 && <OpenToggle open={open} onToggle={toggleOpen} />}</span>
      </div>
      {nfr.status !== 'ok' && <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">{nfr.message}</p>}
      {nfr.variants.length > 0 && (
        <>
          <div ref={measure} className="mt-1.5 w-full">
            <VariantLanes nfr={nfr} width={Math.max(200, width)} highlight={hover ?? channelHover} />
          </div>
          <div className="mt-1 divide-y divide-gray-100 dark:divide-white/5" data-testid="nfr-variant-table">
            {nfr.variants.map(v => (
              <VariantRow key={v.id} v={v} nfr={nfr} profiles={profiles} checked={ticked.has(v.id)} focused={focused === v.id}
                onToggle={on => tick(v.id, on)} feature={variantRef(run, v)}
                featureSelected={selectedKeys.has(featureKey(variantRef(run, v)))} featureHovered={channelHover === v.name}
                onHover={on => setHover(on ? v.name : null)} />
            ))}
          </div>
          <OtherConfigurations nfr={nfr} />
        </>
      )}
      {nfr.depth_states.length > 0 && (
        <table className="mt-1 text-[11px] tabular-nums" data-testid="nfr-depth-table">
          <tbody>
            {nfr.depth_states.map(s => (
              <tr key={s.id}><td className="pr-2">{s.depth}</td><td className="pr-2 text-gray-500">widest gap {s.name} bp</td><td>{pct(s.prevalence)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {open && (
        <CardBody entry={entry} starred={!!starred} ready common={common} onPairs={() => onPairs(nfr.id)}
          details={<NfrDetails nfr={nfr} multiChannel={multiChannel} classesJoined={classesJoined} datasetLabel={common.datasetLabel} result={result} />} />
      )}
    </div>
  );
}

/** Under the variants: what the prevalence counts (and why the read groups count differently), and the per-read
 * configurations that are not one variant (V1+V3, other), expandable, with the rule that assigns reads to them. */
function OtherConfigurations({ nfr }: { nfr: NfrRegionResult }) {
  const others = nfr.configurations.filter(c => c.label !== 'closed' && !/^V\d+$/.test(c.label));
  const share = others.reduce((a, c) => a + (c.weight ?? 0), 0);
  return (
    <div className="mt-1 space-y-0.5 text-[11px] text-gray-600 dark:text-gray-300" data-testid="nfr-card-counts">
      <p className="flex flex-wrap items-center gap-x-1">
        <span data-testid="nfr-card-prevalence-note">{ESTIMATORS.moleculePrevalence}, {formatShare(nfr.callable, nfr.reads, 'reads callable')}</span>
        <HelpTip term="prevalence and the read groups" question="How do prevalence and the read groups differ?" text={HELP.prevalence} testId="nfr-help-prevalence" />
      </p>
      <p data-testid="nfr-card-one-group" title={HELP.prevalence}>A read can count in several variants; Group and Split put each read in one group, so their counts differ.</p>
      {others.length > 0 && (
        <details data-testid="nfr-other-configurations">
          <summary className="cursor-pointer">Other configurations ({others.length}) · {formatPct(share)} of callable reads</summary>
          <p className="mt-0.5 text-ink-muted">{HELP.configurations}</p>
          <ul className="mt-0.5 flex flex-wrap gap-x-3 tabular-nums">
            {others.map(c => <li key={c.label} data-testid="nfr-other-configuration">{c.display_label || c.label} {formatPct(c.weight)}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

/** A starred card of another run (another window, or a session whose run this server no longer has): its stored
 * numbers; open, the analysis when the run is still here, else Go there and find variants. */
export function StoredNfrCard({ entry, ready, common, onFindAgain }: {
  entry: SavedNfr; ready: boolean; common: CardCommon; onFindAgain: (e: SavedNfr) => void;
}) {
  const key = cardKey(entry.jobId, entry.nfrId);
  const open = useAccessibilityStore(s => s.openCard === key);
  const focused = useAccessibilityStore(s => (s.focusedVariant?.card === key ? s.focusedVariant.variantId : null));
  const setView = useAccessibilityStore(s => s.setPanelView);
  const badges = useJobBadges();
  const { remove, setShown } = useBrowserStore(useShallow(s => ({ remove: s.removeSavedNfrVariant, setShown: s.setSavedNfrVariantShown })));
  const [headRef, headStyle] = useStickyHead(open);
  return (
    <div data-testid="nfr-card" data-nfr={entry.nfrId} data-card={key} data-starred="true" data-entry={entry.id} data-stored="true"
      data-variants={shownVariants(entry).map(v => v.name).join(',')} style={headStyle}
      className={`rounded-lg border bg-white/60 dark:bg-white/[0.02] ${open ? 'border-fuchsia-300 shadow-sm dark:border-fuchsia-800/70' : 'border-gray-200 dark:border-gray-700/80'}`}>
      {/* Open: its identity stays in view under the panel's tabs, as a live card's does. */}
      <div ref={headRef} data-testid="nfr-card-head" data-sticky={open || undefined}
        className={`flex items-center gap-2 px-2 py-1.5 ${open ? 'sticky top-[var(--nfr-tabs-h,34px)] z-10 rounded-t-lg border-b border-fuchsia-100 bg-surface dark:border-fuchsia-900/40' : ''}`}>
        <Star starred onToggle={() => remove(entry.id)} name={entry.name} />
        <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: entry.color }} />
        <button type="button" onClick={() => setView({ openCard: open ? null : key, focusedVariant: null })} className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={open} data-testid="nfr-card-open">
          <DisclosureChevron open={open} />
          <span className="min-w-0">
            <span className="block truncate text-[12px] font-semibold text-gray-900 dark:text-gray-100">{entry.name}{badges[`entry:${key}`] ? <NewDot /> : null}</span>
            <span className="block truncate text-[11px] tabular-nums text-gray-500">
              {entry.chrom}:{bp(entry.nfrStart)}–{bp(entry.nfrEnd)} · {entry.variants.length} variant{entry.variants.length === 1 ? '' : 's'} of {entry.callable.toLocaleString()} reads · {entry.datasetIds.map(common.datasetLabel).join(', ')}
            </span>
            <span className="mt-0.5 flex flex-wrap gap-1">
              {entry.variants.map(v => (
                <span key={v.variantId} className={`rounded px-1 text-[10px] font-medium tabular-nums ${v.shown ? 'text-white' : 'text-gray-400 line-through'}`}
                  style={v.shown ? { background: variantColor(v.name) } : undefined} title={`${v.name} ${v.relation}: ${bp(v.start)}–${bp(v.end)}, ${pct(v.prevalence)} of callable reads (stored)`}>
                  {v.name} {pct(v.prevalence)}
                </span>
              ))}
            </span>
          </span>
        </button>
        {!ready && <span className="rounded-full bg-amber-50 px-1.5 py-px text-[10px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" title="This server no longer has the run (sessions keep the last six runs, and a run whose files changed is not restored). The stored geometry and numbers are kept.">run not loaded</span>}
        <button type="button" onClick={() => useBrowserStore.getState().setViewport(entry.chrom, Math.max(0, entry.region.start), entry.region.end)}
          className="rounded px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10" title="Show the run's window in the read panels" data-testid="nfr-card-go">Go there</button>
      </div>
      {open && (
        <div className="border-t border-gray-100 px-2 pb-2 pt-1.5 dark:border-white/5">
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px]" data-testid="nfr-saved-variants">
            {entry.variants.map(v => (
              <label key={v.variantId} data-testid="nfr-saved-variant" data-variant={v.variantId} data-focused={focused === v.variantId || undefined}
                className={`flex items-center gap-1 rounded px-0.5 ${focused === v.variantId ? 'bg-fuchsia-50 ring-2 ring-fuchsia-400 dark:bg-fuchsia-900/30' : ''}`}
                title={`${v.relation}, ${v.depth}; ${bp(v.width)} bp; ${pct(v.prevalence)} (strict ${pct(v.strict)}), stored`}>
                <input type="checkbox" checked={v.shown} data-testid="nfr-saved-variant-toggle" data-variant={v.name}
                  onChange={ev => setShown(entry.id, v.variantId, ev.target.checked)} style={{ accentColor: variantColor(v.name) }} />
                <span className="font-semibold" style={{ color: variantColor(v.name) }}>{v.name}</span>
                <span className="text-gray-500">{v.relation} · {bp(v.start)}–{bp(v.end)} · {pct(v.prevalence)}</span>
              </label>
            ))}
          </div>
          <CardBody entry={entry} starred ready={ready} common={common} onFindAgain={() => onFindAgain(entry)} bare />
        </div>
      )}
    </div>
  );
}

/** The open card: name and note (starred), read controls, pairs, sequence, statistics, then the views. */
function CardBody({ entry, starred, ready, common, onPairs, onFindAgain, details, bare }: {
  entry: SavedNfr; starred: boolean; ready: boolean; common: CardCommon; onPairs?: () => void; onFindAgain?: () => void;
  details?: React.ReactNode; bare?: boolean;
}) {
  const update = useBrowserStore(s => s.updateSavedNfrVariant);
  const [stats, setStats] = useState(false);
  const key = cardKey(entry.jobId, entry.nfrId);
  return (
    <div className={`${bare ? '' : 'mt-2 border-t border-gray-100 pt-2 dark:border-white/5'} space-y-1.5`} data-testid="nfr-card-body">
      {starred && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]" data-testid="nfr-card-name">
          <input type="color" value={entry.color} onChange={ev => update(entry.id, { color: ev.target.value })} className="h-4 w-4 flex-shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" aria-label="Colour" />
          <label className="flex items-center gap-1">Name
            <input type="text" value={entry.name} onChange={ev => update(entry.id, { name: ev.target.value })} className="w-40 rounded border border-gray-200 bg-white px-1 py-0.5 dark:border-gray-700 dark:bg-gray-900" />
          </label>
          <input type="text" value={entry.note ?? ''} placeholder="Note" onChange={ev => update(entry.id, { note: ev.target.value })}
            className="min-w-[8rem] flex-1 rounded border border-gray-200 bg-white px-1 py-0.5 dark:border-gray-700 dark:bg-gray-900" />
        </div>
      )}
      {ready && (
        <div className="flex flex-wrap items-center gap-1.5">
          <ReadControls entry={entry} actions={common.actions} />
          {onPairs && (
            <AnalysisButton theme="fuchsia" variant="quiet" data-testid="nfr-card-pairs" onClick={onPairs}
              title="NFR pairs: the pairs involving this NFR (its variants and the classes they meet), as arcs or a matrix">
              Pairs involving {entry.nfrId}
            </AnalysisButton>
          )}
        </div>
      )}
      {ready && <SequenceRow entry={entry} />}
      {details && (
        <div>
          <button type="button" onClick={() => setStats(d => !d)} data-testid="nfr-details-toggle" aria-expanded={stats}
            className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
            <DisclosureChevron open={stats} /> Statistics
          </button>
          {stats && details}
        </div>
      )}
      {!shownVariants(entry).length ? <AnalysisStatus kind="info">Tick at least one variant to see the views.</AnalysisStatus>
        : ready ? (
          <NfrJobOwnerContext.Provider value={{ tab: 'nfrs', entry: key, label: entry.name }}>
            <SavedNfrInspect entry={entry} stateKeyMap={common.stateKeyMap} isFullView={common.isFullView} />
          </NfrJobOwnerContext.Provider>
        ) : (
          <div className="space-y-1.5">
            <AnalysisStatus kind="info"><span title="Sessions keep the last six runs; a run whose files changed is not restored. The stored geometry and prevalence are kept.">Run not on this server: find variants again here to see the analyses.</span></AnalysisStatus>
            {onFindAgain && <AnalysisButton theme="fuchsia" variant="soft" onClick={onFindAgain}>Go there and find variants</AnalysisButton>}
          </div>
        )}
    </div>
  );
}

/** Copy sequence / Download FASTA: the NFR window and each variant's span (the run's reference). */
export function SequenceRow({ entry }: { entry: SavedNfr }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [perVariant, setPerVariant] = useState(false);
  const run = async (variant: string | undefined, how: 'copy' | 'fasta') => {
    const part = sequencePart(entry, variant);
    if (!part) return;
    setBusy(true); setMsg(null);
    try {
      const seq = await loadNfrSequence(entry.jobId, entry.nfrId);
      const record = fastaRecord(entry, seq, part, variant ? `${variant} ${entry.variants.find(v => v.name === variant)?.relation ?? ''}`.trim() : 'NFR window');
      if (!record) throw new Error('no bases for this span (load the genome FASTA)');
      const where = `${record.chrom}:${(record.start + 1).toLocaleString()}-${record.end.toLocaleString()}`;
      if (how === 'copy') {
        const ok = await copyText(record.bases);
        setMsg(ok ? { ok, text: `Copied ${part.label} (${record.bases.length.toLocaleString()} bp, ${where})` } : { ok, text: 'Could not copy' });
      } else {
        const file = fastaFileName(entry, part, record.start, record.end);
        downloadTextFile(record.text, file, 'text/x-fasta');
        setMsg({ ok: true, text: `Saved ${file}` });
      }
    } catch (e) {
      setMsg({ ok: false, text: `No sequence: ${String((e as Error).message ?? e)}` });
    } finally { setBusy(false); }
  };
  const link = 'rounded px-1 text-[11px] text-fuchsia-700 hover:bg-fuchsia-50 disabled:opacity-40 dark:text-fuchsia-300 dark:hover:bg-white/5';
  return (
    <div className="text-[11px]" data-testid="nfr-card-sequence">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-gray-500" title="The reference the run's datasets use (an alt-allele dataset: its own contig); FASTA headers give 1-based inclusive coordinates">Sequence</span>
        <AnalysisButton theme="fuchsia" variant="quiet" disabled={busy} onClick={() => void run(undefined, 'copy')} data-testid="nfr-seq-copy"
          title={`Copy the bases of ${entry.nfrId} (${entry.chrom}:${(entry.nfrStart + 1).toLocaleString()}-${entry.nfrEnd.toLocaleString()})`}>Copy sequence</AnalysisButton>
        <AnalysisButton theme="fuchsia" variant="quiet" disabled={busy} onClick={() => void run(undefined, 'fasta')} data-testid="nfr-seq-fasta"
          title="Save the NFR window as FASTA (header: name and coordinates)">Download FASTA</AnalysisButton>
        <button type="button" onClick={() => setPerVariant(v => !v)} aria-expanded={perVariant} data-testid="nfr-seq-variants-toggle"
          className="flex items-center gap-1 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"><DisclosureChevron open={perVariant} /> per variant</button>
      </div>
      {perVariant && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1" data-testid="nfr-seq-variants">
          {entry.variants.map(v => (
            <span key={v.variantId} className="inline-flex items-center gap-0.5" data-testid="nfr-seq-variant" data-variant={v.name}>
              <span className="font-semibold" style={{ color: variantColor(v.name) }}>{v.name}</span>
              <span className="tabular-nums text-ink-secondary">{bp(v.start)}–{bp(v.end)}</span>
              <button type="button" className={link} disabled={busy} onClick={() => void run(v.name, 'copy')} data-testid="nfr-seq-variant-copy">copy</button>
              <button type="button" className={link} disabled={busy} onClick={() => void run(v.name, 'fasta')} data-testid="nfr-seq-variant-fasta">FASTA</button>
            </span>
          ))}
        </div>
      )}
      {msg && <p className={`mt-0.5 ${msg.ok ? 'text-fuchsia-700 dark:text-fuchsia-300' : 'text-red-600 dark:text-red-400'}`} data-testid="nfr-seq-notice">{msg.text}</p>}
    </div>
  );
}
