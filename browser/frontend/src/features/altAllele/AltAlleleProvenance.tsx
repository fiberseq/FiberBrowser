/**
 * An insert-expanded panel's provenance (a Preview feature): which carriers it shows and which it left out, and why;
 * how its contig maps to the reference (flanks, breakpoint, insert); how the insert was built; its known limitations.
 * A header pill opens it; the pure text is altAlleleProvenance() (tests, the pill's tooltip).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PreviewBadge, PreviewLimitations } from '../../components/ui/PreviewBadge';
import { ALT_ALLELE_PREVIEW } from './preview';
import type { AltAlleleInfo, AltAlleleLayout } from './types';
import { altAlleleName } from './altAlleleCoords';

export interface ProvenanceSection { title: string; lines: string[] }

const n = (v: number | undefined | null) => (v ?? 0).toLocaleString();
const plural = (v: number, one: string, many = `${one}s`) => `${v.toLocaleString()} ${v === 1 ? one : many}`;

/** The reference stretch a contig segment stands for (1-based, inclusive). */
function refRange(chrom: string, start0: number, end0: number): string {
  return end0 > start0 ? `${chrom}:${(start0 + 1).toLocaleString()}–${end0.toLocaleString()}` : `${chrom} (none)`;
}

/** The provenance as sections of plain lines. */
export function altAlleleProvenance(layout: AltAlleleLayout, info: AltAlleleInfo | undefined, sourceLabel?: string): ProvenanceSection[] {
  const meta = info?.meta;
  const c = meta?.carriers;
  const def = info?.definition;
  const out: ProvenanceSection[] = [];
  out.push({
    title: 'Insertion',
    lines: [
      `+${layout.insert_len.toLocaleString()} bp at ${layout.chrom}:${(layout.ref + 1).toLocaleString()} (the first reference base after it)`
        + (meta?.sv && meta.sv.len !== layout.insert_len ? `; the SV call says +${meta.sv.len.toLocaleString()} bp` : ''),
      ...(sourceLabel ? [`Carriers from ${sourceLabel}`] : []),
    ],
  });
  const leftStart = layout.ref - layout.flank_left;
  out.push({
    title: 'Coordinates (contig ↔ reference)',
    lines: [
      `Contig ${layout.name}, ${layout.length.toLocaleString()} bp: reference flank + insert + reference flank`,
      `1–${layout.insert_start.toLocaleString()} = ${refRange(layout.chrom, leftStart, layout.ref)} (left flank)`,
      `${(layout.insert_start + 1).toLocaleString()}–${layout.insert_end.toLocaleString()} = the insert (no reference coordinates; the ruler shows "ins" positions)`,
      `${(layout.insert_end + 1).toLocaleString()}–${layout.length.toLocaleString()} = ${refRange(layout.chrom, layout.ref, layout.ref + layout.flank_right)} (right flank)`,
      `Breakpoint: between ${layout.chrom}:${layout.ref.toLocaleString()} and ${(layout.ref + 1).toLocaleString()}; positions after the insert are the reference's + ${layout.insert_len.toLocaleString()} bp`,
    ],
  });
  if (meta?.consensus) {
    const method = meta.consensus.method === 'daf' ? 'DAF-aware consensus (FiberHMM)' : 'majority vote';
    out.push({
      title: 'Insert sequence',
      lines: [`${method} of the carriers that hold the whole insert in their alignment, ${n(meta.consensus.length)} bp`
        + (meta.consensus.fallback ? ` (${meta.consensus.fallback})` : '')],
    });
  }
  if (c) {
    const placed = c.written;
    const lines = [
      `${plural(c.total, 'carrier')} found at the site; ${placed.toLocaleString()} placed on the contig`,
      `Whole insert in the alignment: ${n(c.cigar)}`,
      `Soft-clipped at the breakpoint (partial: only the part of the insert they hold): ${n(c.clip_start + c.clip_end)}`
        + (c.clip_start || c.clip_end ? ` (${n(c.clip_start)} at the left, ${n(c.clip_end)} at the right)` : ''),
      `Hard-clipped (partial: their flank only, the clipped bases are not in the read): ${n(c.hard)}`,
    ];
    if (c.sampled) {
      lines.push(`Sampled: more carriers than the cap (${n(def?.max_carriers)}), so ${placed.toLocaleString()} were taken evenly along the site and ${(c.total - placed).toLocaleString()} left out`);
    } else if (c.total > placed) {
      lines.push(`${(c.total - placed).toLocaleString()} could not be placed on the contig (no alignment within the band)`);
    }
    if (c.poorly_aligned) lines.push(`${n(c.poorly_aligned)} placed with under 80% of their insert bases inside the insert (another element here, or a chimeric read)`);
    out.push({ title: 'Carriers', lines });
  }
  const ex = meta?.excluded;
  const left = [
    ex?.other_insert ? `${n(ex.other_insert)} with another insertion at the site (a different length)` : '',
    ex?.not_informative ? `${n(ex.not_informative)} not informative (they don't span the breakpoint)` : '',
    def && !def.include_duplicates ? 'duplicates (flagged) are left out' : '',
  ].filter(Boolean);
  if (left.length) out.push({ title: 'Left out', lines: left });
  if (meta?.reference_reads && def?.include_reference) {
    out.push({ title: 'Reference reads', lines: [`${n(meta.reference_reads.written)} of ${n(meta.reference_reads.total)} shown, the insert drawn as a gap across them`] });
  }
  if (meta?.seconds != null) {
    out.push({ title: 'Build', lines: [`Built in ${meta.seconds.toFixed(1)} s (cached: reopening it or restoring a session reuses the files)`] });
  }
  return out;
}

/**
 * The header pill of an insert-expanded panel: "Pinned to insertion ⓘ" (round 3, R14a: one pill where "PREVIEW ⓘ"
 * and "Pinned to insertion · Show on reference" took the room of the panel's title at 480 px). It opens what the
 * panel shows: that it is pinned to the insertion in its own coordinates, the way back to the reference, which
 * carriers it shows and why others are left out, how its contig maps to the reference, and the known limitations
 * (a Preview feature).
 */
export function AltAlleleProvenancePill({ layout, info, sourceLabel, placed, onShowReference }: {
  layout: AltAlleleLayout; info?: AltAlleleInfo; sourceLabel?: string;
  /** "3,267 of 3,600 carriers at the site … placed here; …" (the header's count is of the reads drawn). */
  placed?: string;
  onShowReference: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 440)) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc); };
  }, [open]);
  const sections = altAlleleProvenance(layout, info, sourceLabel);
  const name = altAlleleName(layout);
  return (
    <>
      <button ref={button} type="button" className="fb-header-pill min-w-0 max-w-[50%] shrink gap-1" data-testid="alt-allele-chip"
        aria-expanded={open} aria-haspopup="dialog"
        aria-label="Pinned to insertion: what this panel shows, and Show on reference"
        onMouseDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        title={`Pinned to the insertion ${name}: carriers only, on its alternate allele, in its own coordinates (a Preview feature). Click for what it shows and Show on reference.`}>
        <span className="min-w-0 truncate">Pinned to insertion</span>
        <span aria-hidden="true" className="shrink-0">ⓘ</span>
      </button>
      {open && pos && createPortal(
        <div ref={box} role="dialog" aria-label="Insert-expanded panel: what it shows" data-testid="alt-allele-provenance"
          className="fixed z-[10000] max-h-[70vh] w-[420px] max-w-[calc(100vw-16px)] overflow-auto rounded-fb border border-line bg-surface p-2.5 text-[11px] leading-4 text-ink shadow-dropdown dark:border-white/10 dark:bg-dark-elevated"
          style={{ top: pos.top, left: pos.left }}
          onMouseDown={e => e.stopPropagation()}>
          <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold">
            Pinned to insertion <PreviewBadge feature={ALT_ALLELE_PREVIEW} />
          </div>
          <p className="mb-1.5">
            Carriers of {name} only, on its alternate allele (reference flank + insert consensus + reference flank, contig {layout.name}), in its own coordinates.
            {placed ? ` ${placed}.` : ''}
          </p>
          <button type="button" className="mb-2 rounded-fb border border-line px-2 py-0.5 text-[11.5px] font-medium hover:bg-gray-50 dark:border-white/15 dark:hover:bg-white/10"
            data-testid="alt-allele-show-reference"
            onClick={() => { setOpen(false); onShowReference(); }}>
            Show on reference
          </button>
          {sections.map(s => (
            <div key={s.title} className="mb-1.5" data-testid="alt-allele-provenance-section" data-title={s.title}>
              <div className="font-medium text-ink-muted">{s.title}</div>
              <ul className="list-disc pl-4">{s.lines.map(line => <li key={line}>{line}</li>)}</ul>
            </div>
          ))}
          <PreviewLimitations feature={ALT_ALLELE_PREVIEW} className="mt-1" />
        </div>,
        document.body,
      )}
    </>
  );
}

/** The building chip's text: what is happening, how long so far, and what to expect the first time. */
export function buildingText(message: string, seconds: number): string {
  return `${message.replace(/…$/, '')}… ${seconds} s (the first build of an insertion takes about 25–40 s for thousands of carriers; later ones reuse it)`;
}

/** Seconds since this chip appeared (the build's progress: the server answers once it is done). */
export function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) { setSeconds(0); return; }
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return seconds;
}
