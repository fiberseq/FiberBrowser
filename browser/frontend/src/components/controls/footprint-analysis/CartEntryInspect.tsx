import { footprintSource, orientFootprint } from '../../../utils/footprintSource';
import { useSplitPanelStore } from '../../../stores/splitPanelStore';
import { usePanelGenomeStore } from '../../../stores/panelGenomeStore';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { analyzeFootprints, type FootprintAnalysisResult } from '../../../api/footprints';
import { declareGenome, DECLARABLE_GENOMES } from '../../../api/reference';
import type { FootprintGroup } from '../../../types';
import { AnnotatedSequenceView, MotifHitList } from './helpers';
import { VPlotChart } from '../../charts/VPlotChart';
import { assignMotifColors } from './constants';
import { AnalysisButton, AnalysisStatus, MotifPinBar, useMotifThreshold } from '../shared';
import { formatP } from '../../../utils/motifSettings';
import { DisclosureChevron } from '../../ui/Disclosure';

/** Sequence, motif scans and the V-plot look at this much flank around a definition. */
const WINDOW_BP = 1000;
const bareChrom = (name: string) => name.replace(/^chr/i, '');

interface CartEntryInspectProps {
  group: FootprintGroup;
  /** Dataset IDs (not panel state keys) the panel is analyzing. */
  targetDatasetIds: string[];
  width: number;
}

/**
 * Details for a saved definition: where it is, its reference sequence with
 * hits from the loaded motif tracks, and an on-demand V-plot around it.
 */
const PINNED_MOTIFS_KEY = 'fiberbrowser-pinned-motifs';

export function CartEntryInspect({ group, targetDatasetIds, width }: CartEntryInspectProps) {
  const [vplotOpen, setVplotOpen] = useState(false);
  // Pinned key factors and your own motifs are shared with the other motif views (per species; utils/pinnedMotifs.ts,
  // utils/motifSettings.ts): JASPAR motifs always reported, besides the best matches. With no list of the user's for
  // the species, the server reports the species' defaults.
  const { pinnedStore, setPinned, motifScoreMode, motifPValue, customMotifs } = useBrowserStore(useShallow(s => ({
    pinnedStore: s.pinnedMotifs, setPinned: s.setPinnedMotifs, motifScoreMode: s.motifScoreMode, motifPValue: s.motifPValue,
    customMotifs: s.customMotifs,
  })));
  const [speciesName, setSpeciesName] = useState<string | null>(null);
  const storedPinned = speciesName ? pinnedStore[speciesName] : undefined;
  const pinnedMotifs = useMemo(() => storedPinned ?? null, [storedPinned]);
  const pinnedKey = pinnedMotifs ? pinnedMotifs.join(',') : '(defaults)';
  // The motif box (shared with the other motif views): Enter pins; a pin with no hit here says so once, with Relax.
  const [motifQuery, setMotifQuery] = useState('');
  const [justPinned, setJustPinned] = useState<string | null>(null);
  const [pinNotice, setPinNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const threshold = useMotifThreshold();
  const customKey = JSON.stringify(customMotifs);
  const [highlightedMotif, setHighlightedMotif] = useState<string | null>(null);
  const { chrom, start, end, spanningOnly, hasFasta: mainHasFasta, currentGenome, motifThreshold, analysisSampleCount, analysisSampleSeed, orthogonalTracks } =
    useBrowserStore(useShallow(s => ({
      chrom: s.chrom,
      start: s.start,
      end: s.end,
      spanningOnly: s.spanningOnly,
      hasFasta: s.hasFasta,
      currentGenome: s.currentGenome,
      motifThreshold: s.motifThreshold,
      analysisSampleCount: s.analysisSampleCount,
      analysisSampleSeed: s.analysisSampleSeed,
      orthogonalTracks: s.orthogonalTracks,
    })));
  useSplitPanelStore(s => s.reads);
  const sourceKey = useBrowserStore(s => JSON.stringify(footprintSource(s, group, targetDatasetIds)));
  const source = useMemo(() => JSON.parse(sourceKey) as ReturnType<typeof footprintSource>, [sourceKey]);
  const scopedIds = useMemo(() => source.datasetIds, [sourceKey]);
  const ownHasFasta = usePanelGenomeStore(s => source.genome ? Boolean(s.genomes[source.genome]?.has_fasta) : null);
  const hasFasta = ownHasFasta ?? mainHasFasta;

  const refStart = group.referenceAbsStart;
  const refEnd = group.referenceAbsEnd;
  const hasReference = refStart != null && refEnd != null;
  // Look at the definition's own position, not whatever the browser shows now.
  const refChrom = source.chrom;
  const elsewhere = hasReference && bareChrom(refChrom) !== bareChrom(source.viewChrom);
  const regionStart = hasReference ? Math.max(0, Math.round(refStart!) - WINDOW_BP) : start;
  const regionEnd = hasReference ? Math.round(refEnd!) + WINDOW_BP : end;
  const legacyMotifTracks = orthogonalTracks.filter(t => t.category === 'motif' && t.format !== 'custom_motif').length;
  // Every loaded motif is a scanned PWM track; scan them all at the reference.
  const motifTrackIndices = useMemo(
    () => orthogonalTracks.filter(t => t.category === 'motif' && t.format === 'custom_motif').map(t => t.index),
    [orthogonalTracks],
  );
  const motifKey = motifTrackIndices.join(',');

  // The position (and settings) a sequence result was fetched for: a result is
  // shown only while it still describes this definition.
  const seqScopeKey = JSON.stringify([hasReference, sourceKey, refChrom, refStart ?? null, refEnd ?? null,
    regionStart, regionEnd, group.layer ?? null, motifKey, motifScoreMode, motifScoreMode === 'p' ? motifPValue : motifThreshold, pinnedKey, customKey]);
  const [seqEntry, setSeqEntry] = useState<{ key: string; res: FootprintAnalysisResult } | null>(null);
  const seqResult = seqEntry?.key === seqScopeKey ? seqEntry.res : null;
  const setSeqResult = (res: FootprintAnalysisResult | null, key = seqScopeKey) => setSeqEntry(res ? { key, res } : null);
  const [seqLoading, setSeqLoading] = useState(false);
  const [seqError, setSeqError] = useState<string | null>(null);
  const seqTokenRef = useRef(0);
  // A genome declared for a FASTA (here or in any other view): rescan with its species.
  const referenceRevision = useBrowserStore(s => s.referenceRevision);
  const [declareError, setDeclareError] = useState<string | null>(null);

  useEffect(() => {
    // Every scope change supersedes a request still running, including one
    // that ends here (e.g. "Match anywhere" drops the position).
    const token = ++seqTokenRef.current;
    const key = seqScopeKey;
    if (!hasReference || !scopedIds.length || !hasFasta) {
      setSeqResult(null);
      setSeqLoading(false);
      return;
    }
    setSeqLoading(true);
    setSeqError(null);
    analyzeFootprints(
      refChrom, regionStart, regionEnd, spanningOnly,
      [{ absStart: refStart!, absEnd: refEnd!, size: refEnd! - refStart!, readId: '__cart_ref__', datasetId: scopedIds[0] }],
      scopedIds,
      {
        panelGenome: source.genome,
        // JASPAR CORE for the genome (best matches), plus any loaded motif tracks.
        autoMotifs: true,
        motifs: true,
        motifTrackIndices,
        ...(pinnedMotifs ? { customMotifNames: pinnedMotifs } : { pinnedDefaults: true }),
        ...(customMotifs.length ? { customPwms: customMotifs } : {}),
        motifThreshold, motifMode: motifScoreMode, motifP: motifPValue,
        flankBp: 20,
        profileWindow: 100,
        layer: group.layer ?? undefined,
        readAnalysis: false,
        maxReads: analysisSampleCount ?? undefined,
        sampleSeed: analysisSampleSeed,
      },
    )
      .then(res => { if (token === seqTokenRef.current) setSeqResult(res, key); })
      .catch(err => {
        if (token !== seqTokenRef.current) return;
        setSeqResult(null);
        setSeqError(err?.message || String(err));
      })
      .finally(() => { if (token === seqTokenRef.current) setSeqLoading(false); });
  // currentGenome: re-fetch once a genome finishes loading.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasReference, sourceKey, refStart, refEnd, refChrom, regionStart, regionEnd, spanningOnly, targetDatasetIds, motifThreshold,
      hasFasta, currentGenome, group.layer, motifKey, analysisSampleCount, analysisSampleSeed, pinnedKey, motifScoreMode, motifPValue, customKey,
      referenceRevision]);

  // The species (from the scan) picks the shared pinned list; an older per-browser list moves to it once.
  useEffect(() => {
    const name = seqResult?.jaspar_species?.name;
    if (!name || name === speciesName) return;
    setSpeciesName(name);
    try {
      const old = localStorage.getItem(PINNED_MOTIFS_KEY);
      if (old && old.trim() && !useBrowserStore.getState().pinnedMotifs[name]) {
        const reported = seqResult?.motif_scoring?.pinned ?? [];
        setPinned(name, [...new Set([...reported, ...old.split(/[,\s]+/).map(v => v.trim()).filter(Boolean)])]);
      }
      if (old != null) localStorage.removeItem(PINNED_MOTIFS_KEY);
    } catch { /* storage unavailable */ }
  }, [seqResult, speciesName, setPinned]);
  const reportedPinned = seqResult?.motif_scoring?.pinned ?? pinnedMotifs ?? [];
  const unavailable = seqResult?.motif_scoring?.unavailable ?? [];
  const pinMotif = (text: string) => {
    setMotifQuery('');
    setPinNotice(null);
    if (!speciesName) { setPinNotice({ ok: false, text: 'Motifs are pinned per species: load the genome first.' }); return; }
    const already = reportedPinned.find(x => x.toLowerCase() === text.toLowerCase());
    if (already) { setJustPinned(already); setPinNotice(null); return; }
    setPinned(speciesName, [...reportedPinned, text]);
    setJustPinned(text);
    setPinNotice({ ok: true, text: `Pinned ${text}: scanning…` });
  };
  const unpinMotif = (name: string) => { if (speciesName) setPinned(speciesName, reportedPinned.filter(x => x !== name)); setJustPinned(null); setPinNotice(null); };
  const footprint = orientFootprint(seqResult?.footprints?.[0], source.reversed);
  const hits = footprint?.motif_hits ?? [];
  // Why JASPAR wasn't scanned (no genome, species not covered, ...).
  const motifWarnings = (seqResult?.warnings ?? []).filter(w => /jaspar|motif|genome/i.test(w));
  const motifColors = useMemo(() => assignMotifColors([...new Set(hits.map(hit => hit.motif_name))]), [hits]);
  const toggleMotif = (name: string) => setHighlightedMotif(current => current === name ? null : name);
  const species = seqResult?.jaspar_species;
  const speciesText = !species ? '' : species.fallback
    ? ` ${species.name ?? 'vertebrates'} (no genome declared)`
    : ` ${species.name ?? `taxid ${species.taxid}`} (${species.genome}${species.inferred ? ', from the chromosomes'
      : species.inherited ? ', the genome it was built from' : species.declared ? ', declared' : ''})`;
  // A custom FASTA (no genome, or one the user declared): say which genome it comes from.
  const canDeclare = !!species && (!!species.fallback || !!species.declared);
  const onDeclare = (value: string) => {
    setDeclareError(null);
    declareGenome(value || null, source.genome)
      .then(res => { if (!res.success) setDeclareError(res.error || 'Could not declare the genome'); })
      .catch(err => setDeclareError(err?.message || String(err)));
  };
  // Once the rescan answers: a just-pinned motif with hits here, none at the threshold, or not in JASPAR CORE.
  const justPinnedHits = justPinned ? hits.filter(h => h.motif_name.toLowerCase() === justPinned.toLowerCase() || (h.family ?? []).some(f => f.toLowerCase() === justPinned.toLowerCase())).length : 0;
  const pinnedNow = !!justPinned && !!seqResult && reportedPinned.some(x => x.toLowerCase() === justPinned.toLowerCase());
  const notFound = justPinned ? (seqResult?.warnings ?? []).some(w => /not found in JASPAR CORE/i.test(w) && w.includes(justPinned)) : false;
  const message = pinnedNow && !seqLoading
    ? notFound ? { ok: false, text: `${justPinned}: not found in JASPAR CORE${species?.name ? ` (${species.name})` : ''}` }
      : justPinnedHits ? { ok: true, text: `${justPinned}: ${justPinnedHits} hit${justPinnedHits === 1 ? '' : 's'} here` } : null
    : pinNotice;
  const zeroHits = pinnedNow && !seqLoading && !notFound && !justPinnedHits ? [justPinned!] : [];

  return (
    <div className="min-w-0 max-w-full space-y-2 border-t border-gray-200 pt-2 dark:border-gray-700" data-testid="entry-inspect">
      {hasReference ? (
        <div className="text-[11px] text-gray-500 dark:text-gray-400">
          <span className="font-medium text-emerald-600 dark:text-emerald-400">Position</span>{' '}
          {refChrom}:{Math.round(refStart!).toLocaleString()}-{Math.round(refEnd!).toLocaleString()} ({Math.round(refEnd! - refStart!)} bp)
        </div>
      ) : (
        <div className="text-[11px] text-gray-500">Matches footprints of this size anywhere in view.</div>
      )}

      {elsewhere && (
        <div className="flex items-center gap-2 text-[11px] text-gray-500">
          On {refChrom}, outside this view.
          <AnalysisButton theme="emerald" variant="soft"
            onClick={() => { const s = useBrowserStore.getState(); s.recordJump(source.panelId); if (source.panelId) s.navigatePanel(source.panelId, refChrom, regionStart, regionEnd); else s.setViewport(refChrom, regionStart, regionEnd); }}>
            Go there
          </AnalysisButton>
        </div>
      )}
      {hasReference && !hasFasta && (
        <div className="text-[11px] text-gray-500">Load a genome or FASTA to see the sequence and motif hits.</div>
      )}
      {hasReference && hasFasta && seqLoading && <AnalysisStatus kind="loading" compact>Loading sequence…</AnalysisStatus>}
      {hasReference && hasFasta && seqError && <AnalysisStatus kind="error" compact>{seqError}</AnalysisStatus>}
      {hasReference && hasFasta && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-600 dark:text-gray-300" data-testid="entry-motif-controls">
          <span title={species?.inferred ? `The loaded chromosomes are ${species.genome}-like, so ${species.name ?? 'that species'} motifs are used` : undefined}>
            Motifs: JASPAR{speciesText}
          </span>
          {canDeclare && (
            <label className="inline-flex items-center gap-1" title="The genome this sequence comes from: its JASPAR species is scanned (positions stay the sequence's own)">
              Sequence from
              <select data-testid="entry-motif-declare" value={species?.declared ? species.genome ?? '' : ''}
                onChange={e => onDeclare(e.target.value)}
                className="rounded border border-gray-300 bg-white px-1 py-px text-[11px] dark:border-gray-600 dark:bg-gray-800">
                <option value="">{species?.fallback ? 'not declared' : 'clear'}</option>
                {DECLARABLE_GENOMES.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
          )}
          {declareError && <span className="text-amber-700 dark:text-amber-300" role="alert">{declareError}</span>}
        </div>
      )}
      {hasReference && hasFasta && (
        <MotifPinBar testIdPrefix="entry-motif" query={motifQuery} onQuery={q => { setMotifQuery(q); setPinNotice(null); }} onPin={pinMotif}
          pinned={reportedPinned} onUnpin={unpinMotif} onReset={pinnedMotifs && speciesName ? () => setPinned(speciesName, null) : undefined}
          zeroHits={zeroHits} notice={message} unavailable={unavailable} placeholder="Pin a motif (name, Enter)"
          pinsNote="always reported here besides the best matches; shared with the other motif views, per species" />
      )}
      {footprint?.sequence && (
        <>
          <AnnotatedSequenceView
            sequence={footprint.sequence}
            motifHits={hits}
            highlightedMotif={highlightedMotif}
            onMotifClick={toggleMotif}
            motifColors={motifColors}
          />
          {hits.length > 0 ? (
            <MotifHitList hits={hits} highlightedMotif={highlightedMotif} onMotifClick={toggleMotif} motifColors={motifColors} />
          ) : (
            <div className="flex flex-wrap items-center gap-x-1 text-[11px] text-gray-600 dark:text-gray-300" data-testid="entry-motif-none" role="status">
              No JASPAR{motifTrackIndices.length > 0 ? ' or loaded' : ''} motif hits at {motifScoreMode === 'p' ? `p ≤ ${formatP(motifPValue)}` : `≥ ${Math.round(motifThreshold * 100)}% of each matrix's score range`}
              {threshold.relax && <button type="button" onClick={threshold.relax} data-testid="entry-motif-none-relax"
                title={`Call sites at ${threshold.relaxedText} instead, in every motif view (the threshold is shared)`}
                className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">· Relax to {threshold.relaxedText}</button>}
            </div>
          )}
          <div className="text-[11px] text-ink-secondary">
            Best JASPAR CORE matches for this genome ({motifScoreMode === 'p' ? 'ranked by p-value; similar matrices on the same bases shown as one' : 'ranked by score'}){reportedPinned.length ? `, plus pinned ${reportedPinned.join(', ')}` : ''}{customMotifs.length ? `, plus your ${customMotifs.length} motif${customMotifs.length === 1 ? '' : 's'}` : ''}{motifTrackIndices.length > 0 ? `, plus your ${motifTrackIndices.length} motif track${motifTrackIndices.length === 1 ? '' : 's'}` : ''}.
            {legacyMotifTracks > 0 && ' Motif tracks from older sessions are not scanned; add them again from Tracks.'}
          </div>
          {motifWarnings.filter(w => !(justPinned && /not found in JASPAR CORE/i.test(w) && w.includes(justPinned))).map(w => <div key={w} className="text-[11px] text-amber-700 dark:text-amber-300">{w}</div>)}
        </>
      )}

      <div>
        <AnalysisButton onClick={() => setVplotOpen(open => !open)} theme="emerald" variant="soft"
          title="Footprint size × position around this definition, for the reads in view">
          <span className="inline-flex items-center gap-1"><DisclosureChevron open={vplotOpen} />{vplotOpen ? 'Hide V-plot' : 'Show V-plot'}</span>
        </AnalysisButton>
        {vplotOpen && (
          <CartEntryVPlot
            group={group}
            targetDatasetIds={scopedIds}
            genome={source.genome}
            reversed={source.reversed}
            readIdsByDataset={source.readIdsByDataset}
            chrom={refChrom}
            start={regionStart}
            end={regionEnd}
            spanning={spanningOnly}
            width={width}
            analysisSampleCount={analysisSampleCount}
            analysisSampleSeed={analysisSampleSeed}
          />
        )}
      </div>
    </div>
  );
}

/** V-plot resolutions: size-bin × position-bin (bp). */
const VPLOT_RESOLUTIONS = {
  fine: { sizeBin: 2, posBin: 5 },
  normal: { sizeBin: 5, posBin: 10 },
  coarse: { sizeBin: 10, posBin: 20 },
} as const;

/** A number box that applies on Enter or leaving it (no refetch per keystroke). */
function CommitNumber({ value, min, max, label, onCommit }: { value: number; min: number; max: number; label: string; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const v = Math.round(Number(text));
    if (Number.isFinite(v)) onCommit(Math.max(min, Math.min(max, v)));
    else setText(String(value));
  };
  return (
    <input type="number" min={min} max={max} value={text} aria-label={label} title={label}
      onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); }}
      className="w-12 rounded border border-gray-300 bg-white px-1 py-0 text-right text-[11px] tabular-nums dark:border-gray-600 dark:bg-gray-800" />
  );
}

function VPlotCompactControls({ view, maxWindow, onChange }: {
  view: { window: number; sizeMin: number; sizeMax: number; resolution: keyof typeof VPLOT_RESOLUTIONS; log: boolean };
  maxWindow: number;
  onChange: (next: Partial<{ window: number; sizeMin: number; sizeMax: number; resolution: keyof typeof VPLOT_RESOLUTIONS; log: boolean }>) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-600 dark:text-gray-300" data-testid="vplot-controls">
      <span className="flex items-center gap-0.5" title="Distance from the definition's position shown on each side (x axis)">
        ±<CommitNumber value={view.window} min={50} max={maxWindow} label="V-plot half-width (bp)" onCommit={v => onChange({ window: v })} /> bp
      </span>
      <span className="flex items-center gap-0.5" title="Footprint sizes shown (y axis)">
        size <CommitNumber value={view.sizeMin} min={0} max={view.sizeMax - 10} label="V-plot minimum size (bp)" onCommit={v => onChange({ sizeMin: v })} />
        –<CommitNumber value={view.sizeMax} min={view.sizeMin + 10} max={1000} label="V-plot maximum size (bp)" onCommit={v => onChange({ sizeMax: v })} /> bp
      </span>
      <label className="flex items-center gap-0.5" title="Bin size: fine 2 bp size × 5 bp position; normal 5 × 10; coarse 10 × 20">
        <select value={view.resolution} aria-label="V-plot resolution" onChange={e => onChange({ resolution: e.target.value as keyof typeof VPLOT_RESOLUTIONS })}
          className="rounded border border-gray-300 bg-white px-0.5 py-0 text-[11px] dark:border-gray-600 dark:bg-gray-800">
          <option value="fine">fine</option><option value="normal">normal</option><option value="coarse">coarse</option>
        </select>
      </label>
      <label className="flex items-center gap-0.5" title="Log color scale (shows faint signal next to strong)">
        <input type="checkbox" checked={view.log} onChange={e => onChange({ log: e.target.checked })} /> log
      </label>
    </div>
  );
}

/** V-plot centered on the definition's position, fetched when opened. */
function CartEntryVPlot({
  group, targetDatasetIds, chrom, start, end, spanning, width, analysisSampleCount, analysisSampleSeed, genome, reversed, readIdsByDataset,
}: {
  group: FootprintGroup;
  targetDatasetIds: string[];
  chrom: string;
  start: number;
  end: number;
  spanning: boolean;
  genome: string | null;
  reversed: boolean;
  readIdsByDataset?: Record<string, string[]>;
  width: number;
  analysisSampleCount: number | null;
  analysisSampleSeed: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plot, setPlot] = useState<{ matrix: number[][]; size_min: number; size_max: number; size_bin: number; pos_bin: number; window: number } | null>(null);
  const tokenRef = useRef(0);
  const refStart = group.referenceAbsStart ?? Math.floor((start + end) / 2);
  const refEnd = group.referenceAbsEnd ?? refStart + 1;
  // Axes and resolution. TF-sized definitions open at TF scale; everything
  // else shows up to nucleosomes. The window can't exceed half the view.
  const maxWindow = Math.max(50, Math.min(2000, Math.floor((end - start) / 2)));
  const [view, setView] = useState(() => ({
    window: Math.min(500, maxWindow),
    sizeMin: 10,
    sizeMax: Math.max(60, Math.min(600, group.sizeMax ?? 300)),
    resolution: 'normal' as keyof typeof VPLOT_RESOLUTIONS,
    log: true,
  }));
  const window_ = Math.min(view.window, maxWindow);
  const { sizeBin, posBin } = VPLOT_RESOLUTIONS[view.resolution];

  useEffect(() => {
    if (!targetDatasetIds.length) return;
    const token = ++tokenRef.current;
    setLoading(true);
    setError(null);
    analyzeFootprints(
      chrom, start, end, spanning,
      [{ absStart: refStart, absEnd: refEnd, size: refEnd - refStart, readId: '__cart_ref__', datasetId: targetDatasetIds[0] }],
      targetDatasetIds,
      {
        panelGenome: genome, readIdsByDataset,
        autoMotifs: false, sequences: false, motifs: false, overlap: false, profiles: true, vplot: true, coocc: false,
        profileWindow: window_,
        vplotSizeMin: view.sizeMin, vplotSizeMax: view.sizeMax, vplotSizeBin: sizeBin, vplotPosBin: posBin,
        vplotLog: view.log, vplotSmooth: 1.0,
        layer: group.layer ?? undefined,
        maxReads: analysisSampleCount ?? undefined,
        sampleSeed: analysisSampleSeed,
      },
    )
      .then(res => {
        if (token !== tokenRef.current) return;
        const datasetId = targetDatasetIds[0];
        const vplot = res?.vplot?.[datasetId];
        setPlot(vplot?.matrix ? {
          matrix: reversed ? vplot.matrix.map(row => [...row].reverse()) : vplot.matrix, size_min: vplot.size_min, size_max: vplot.size_max, size_bin: vplot.size_bin,
          pos_bin: vplot.pos_bin, window: res?.profiles?.[datasetId]?.window || 500,
        } : null);
      })
      .catch(err => { if (token === tokenRef.current) setError(err?.message || String(err)); })
      .finally(() => { if (token === tokenRef.current) setLoading(false); });
  }, [chrom, start, end, spanning, targetDatasetIds, genome, reversed, JSON.stringify(readIdsByDataset), refStart, refEnd, group.layer, window_, view.sizeMin, view.sizeMax,
      sizeBin, posBin, view.log, analysisSampleCount, analysisSampleSeed]);

  return (
    <div className="mt-1 space-y-1">
      <VPlotCompactControls view={{ ...view, window: window_ }} maxWindow={maxWindow} onChange={next => setView(v => ({ ...v, ...next }))} />
      {loading && <AnalysisStatus kind="loading" compact>Computing V-plot…</AnalysisStatus>}
      {error && <AnalysisStatus kind="error" compact>{error}</AnalysisStatus>}
      {!loading && !error && (!plot || plot.matrix.length === 0) && <AnalysisStatus kind="empty" compact>No V-plot data.</AnalysisStatus>}
      {plot && plot.matrix.length > 0 && (
        <VPlotChart
          matrix={plot.matrix}
          sizeMin={plot.size_min}
          sizeMax={plot.size_max}
          sizeBin={plot.size_bin}
          posBin={plot.pos_bin}
          windowBp={plot.window}
          width={Math.max(220, width - 16)}
          height={160}
          filename={`saved_${group.id}_vplot`}
          bandLabels
          centerCaption="x = bp from this definition's position"
        />
      )}
    </div>
  );
}
