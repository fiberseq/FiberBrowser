import { useRef, useEffect, useMemo, useState } from 'react';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import type { ChromInfo } from '../../types';
import { setupHighDpiCanvas, useCanvasRenderVersion } from '../../utils/canvasUtils';
import { getSequence } from '../../api/reference';
import { findChromInfo } from '../../utils/chromAliases';
import { usePanOffsetTransform } from '../../hooks/usePanOffsetTransform';
import { trackBackground } from './TrackContainerConstants';

// IGV-style base colors
const BASE_COLORS: Record<string, string> = {
  A: '#00b300',
  T: '#ff0000',
  C: '#0000ff',
  G: '#e6a800',
  N: '#999999',
};

// Complement map for reverse view: the IUPAC codes too (R↔Y, K↔M, B↔V, D↔H;
// S, W and N are their own), in both cases (soft-masked bases are lowercase).
const UPPER_COMPLEMENT: Record<string, string> = {
  A: 'T', T: 'A', C: 'G', G: 'C', N: 'N', U: 'A',
  R: 'Y', Y: 'R', K: 'M', M: 'K', B: 'V', V: 'B', D: 'H', H: 'D', S: 'S', W: 'W',
};
export const COMPLEMENT: Record<string, string> = Object.fromEntries(
  Object.entries(UPPER_COMPLEMENT).flatMap(([k, v]) => [[k, v], [k.toLowerCase(), v.toLowerCase()]]),
);

/** After a genome switch, how long the track waits for the new chromosome list. */
const REFERENCE_SWITCH_WAIT_MS = 3000;

interface Props {
  width: number;
  height: number;
  overrideChrom?: string;
  overrideStart?: number;
  overrideEnd?: number;
  /** Its panel's reference when that is another assembly than the main genome (services/panel_genomes.py). */
  genome?: string | null;
}

interface CachedSequence {
  chrom: string;
  start: number;
  end: number;
  sequence: string;
}

export function SequenceTrack({ width, height, overrideChrom, overrideStart, overrideEnd, genome }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRenderVersion = useCanvasRenderVersion();
  const cacheRef = useRef<CachedSequence | null>(null);
  const [sequence, setSequence] = useState<string | null>(null);
  const [seqStart, setSeqStart] = useState(0);

  const storeChrom = useBrowserStore(s => s.chrom);
  const storeStart = useBrowserStore(s => s.start);
  const storeEnd = useBrowserStore(s => s.end);
  const mainChroms = useBrowserStore(s => s.chroms);
  // The reference these bases come from: a newly loaded FASTA (or genome)
  // replaces the chromosome list, so cached bases from the old one are dropped.
  // A panel on another assembly reads its own reference.
  const mainGenome = useBrowserStore(s => s.currentGenome);
  const mainFastaPath = useBrowserStore(s => s.fastaPath);
  const genomeInfo = usePanelGenomeStore(s => (genome ? s.genomes[genome] : undefined));
  const ownChroms = useMemo<ChromInfo[] | null>(
    () => (genome ? (genomeInfo?.chroms ?? []).map(c => ({ name: c.name, size: c.size, circular: c.circular })) : null),
    [genome, genomeInfo],
  );
  const chroms = ownChroms ?? mainChroms;
  const currentGenome = genome ?? mainGenome;
  const fastaPath = genome ? (genomeInfo?.fasta_path ?? null) : mainFastaPath;
  const isReversed = useBrowserStore(s => s.isReversed);
  const darkMode = useBrowserStore(s => s.darkMode);

  const useOverride = overrideStart !== undefined && overrideEnd !== undefined;
  const chrom = overrideChrom ?? storeChrom;
  const start = useOverride ? overrideStart : storeStart;
  const end = useOverride ? overrideEnd : storeEnd;
  usePanOffsetTransform(canvasRef, { enabled: !useOverride });
  const regionSize = end - start;
  const chromInfo = findChromInfo(chroms, chrom);
  const isCircular = Boolean(chromInfo?.circular);

  useEffect(() => {
    cacheRef.current = null;
  }, [chroms, currentGenome, fastaPath]);

  // Just after a switch of genome, the chromosome list and the view are still
  // the old genome's until they're replaced: a fetch then would ask the new
  // reference for an old chromosome (a 404). For a few seconds after a switch,
  // wait for the new list and for a chromosome that is on it; after that,
  // fetch as before whatever came (or didn't). A FASTA path reported later
  // for the same genome is no switch.
  const switchRef = useRef({ genome: currentGenome, chroms, staleChroms: null as typeof chroms | null, until: 0 });
  if (switchRef.current.genome !== currentGenome) {
    switchRef.current.staleChroms = switchRef.current.chroms;
    switchRef.current.until = Date.now() + REFERENCE_SWITCH_WAIT_MS;
  }
  switchRef.current.genome = currentGenome;
  switchRef.current.chroms = chroms;
  const [, setSwitchWaitOver] = useState(0);
  const switching = switchRef.current.until > Date.now();
  useEffect(() => {
    if (!switching) return;
    const timer = setTimeout(() => {
      switchRef.current.until = 0;
      switchRef.current.staleChroms = null;
      setSwitchWaitOver(n => n + 1);
    }, Math.max(0, switchRef.current.until - Date.now()));
    return () => clearTimeout(timer);
  }, [switching, currentGenome]);
  const awaitingReference = switching
    && (switchRef.current.staleChroms === chroms || (chroms.length > 0 && !chromInfo));

  // Fetch sequence with 2x padding for cache
  useEffect(() => {
    if (regionSize > 2000 || awaitingReference) {
      setSequence(null);
      return;
    }

    const cached = cacheRef.current;
    if (cached && cached.chrom === chrom && cached.start <= start && cached.end >= end) {
      // Use cached data
      setSequence(cached.sequence.slice(start - cached.start, end - cached.start));
      setSeqStart(start);
      return;
    }

    // Fetch with padding
    const padding = Math.max(regionSize, 500);
    const fetchStart = isCircular ? start : Math.max(0, start - padding);
    const fetchEnd = isCircular ? end : end + padding;

    let cancelled = false;
    getSequence(chrom, fetchStart, fetchEnd, genome)
      .then(res => {
        if (cancelled) return;
        cacheRef.current = {
          chrom,
          start: fetchStart,
          end: fetchStart + res.sequence.length,
          sequence: res.sequence,
        };
        setSequence(res.sequence.slice(start - fetchStart, end - fetchStart));
        setSeqStart(start);
      })
      .catch(() => {
        if (!cancelled) setSequence(null);
      });

    return () => { cancelled = true; };
  }, [chrom, start, end, regionSize, isCircular, chroms, currentGenome, fastaPath, awaitingReference, genome]);

  // Render canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;

    const ctx = setupHighDpiCanvas(canvas, width, height);
    if (!ctx) return;
    // No sequence here (failed or empty fetch): clear, so the last region's
    // bases don't stay on screen under the new axis.
    if (!sequence) {
      ctx.clearRect(0, 0, width, height);
      return;
    }

    // Background
    ctx.fillStyle = trackBackground('sequence', darkMode);
    ctx.fillRect(0, 0, width, height);

    const bpPerPixel = regionSize / width;
    const showLetters = regionSize <= 200;

    // Each base at its own genomic position: past a contig end the sequence is
    // shorter than the view, and those positions stay blank.
    const offset = seqStart - start;
    for (let i = 0; i < sequence.length; i++) {
      let base = sequence[i];
      let drawIdx = offset + i;

      if (isReversed) {
        base = COMPLEMENT[base] || base;
        drawIdx = regionSize - 1 - drawIdx;
      }

      const x = (drawIdx / regionSize) * width;
      const w = (1 / regionSize) * width;
      const color = BASE_COLORS[base] || BASE_COLORS.N;

      if (showLetters) {
        // Colored background with letter
        ctx.fillStyle = color;
        ctx.fillRect(x, 0, w, height);
        // Letter
        ctx.fillStyle = '#ffffff';
        const fontSize = Math.min(14, w * 0.8);
        ctx.font = `bold ${fontSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(base, x + w / 2, height / 2);
      } else {
        // Just colored blocks
        ctx.fillStyle = color;
        ctx.fillRect(x, 2, w, height - 4);
      }
    }

  }, [sequence, seqStart, start, width, height, regionSize, isReversed, darkMode, canvasRenderVersion]);

  if (regionSize > 2000) return null;

  return (
    <div style={{ width, height, overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        style={{ width, height, display: 'block' }}
      />
    </div>
  );
}
