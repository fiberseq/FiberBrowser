import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChromInfo } from '../../types';
import { useBrowserStore } from '../../stores/browserStore';

function formatSize(size: number): string {
  if (size >= 1e6) return `${(size / 1e6).toFixed(1)} Mb`;
  if (size >= 1e3) return `${(size / 1e3).toFixed(0)} kb`;
  return `${size} bp`;
}

/** Unplaced, alternate, patch and decoy contigs (hg38 alone has ~400). */
// Suffix/prefix conventions match any case. hg19-style alternate haplotypes
// (chr6_apd_hap1) are secondary, but phased chromosomes like chr1_hap1 stay
// primary. GenBank accessions (KI270728.1) are matched case-sensitively so
// lowercase contig names that merely start with those letters are kept.
const SECONDARY_CONTIG_RE = /(_alt|_random|_fix|_decoy)$|^(chr)?Un_|^(chr)?Un$|^HLA-|^(chr)?EBV$|^(chr)?[^_]+_[^_]+_hap\d+$/i;
const ACCESSION_CONTIG_RE = /^(KI|GL|JH|KN|KV|KZ|ML|MU)\d{5,}/;

export function isSecondaryContig(name: string): boolean {
  return SECONDARY_CONTIG_RE.test(name) || ACCESSION_CONTIG_RE.test(name);
}

/** The select's entry that opens the other-contigs picker (never a contig name). */
export const OTHER_CONTIGS_VALUE = '__fb_other_contigs__';
/** Matches shown at once in the picker (type to narrow the rest). */
const PICKER_LIMIT = 200;

/**
 * The chromosome dropdown: the primary chromosomes only (plus the current
 * contig when it is a secondary one), then "Other contigs (N)…", which opens
 * a searchable picker for the hundreds of unplaced, alt and random contigs
 * (455 in hg38, 1,870 in dm6) instead of listing them all.
 */
export function ChromSelector() {
  const chroms = useBrowserStore(s => s.chroms);
  const chrom = useBrowserStore(s => s.chrom);
  const setViewport = useBrowserStore(s => s.setViewport);
  const [pickerOpen, setPickerOpen] = useState(false);

  const { primary, secondary } = useMemo(() => {
    // If nothing looks primary (e.g. only unplaced contigs), list everything.
    const split = chroms.some(c => !isSecondaryContig(c.name));
    return {
      primary: split ? chroms.filter(c => !isSecondaryContig(c.name)) : chroms,
      secondary: split ? chroms.filter(c => isSecondaryContig(c.name)) : [],
    };
  }, [chroms]);

  if (chroms.length === 0) return null;
  const current = secondary.find(c => c.name === chrom);

  const go = (name: string) => {
    const info = chroms.find(c => c.name === name);
    if (!info) return;
    const windowSize = Math.min(20000, info.size);
    setViewport(name, 0, windowSize);
  };

  return (
    <span className="relative inline-flex">
      <select
        value={chrom}
        data-testid="chrom-selector"
        aria-label="Chromosome"
        onChange={(e) => {
          const name = e.target.value;
          if (name === OTHER_CONTIGS_VALUE) {
            setPickerOpen(true);
            return;
          }
          go(name);
        }}
        className="max-w-[130px] px-1.5 py-0.5 border border-line shadow-chip dark:border-white/10 rounded-fb text-xs bg-white dark:bg-dark-surface text-gray-700 dark:text-gray-300 truncate focus:outline-none focus:border-brand-400 focus:ring-[3px] focus:ring-brand-500/20"
        title="Select chromosome"
      >
        {primary.map(c => (
          <option key={c.name} value={c.name}>
            {c.name} ({formatSize(c.size)})
          </option>
        ))}
        {current && (
          <option key={current.name} value={current.name}>
            {current.name} ({formatSize(current.size)})
          </option>
        )}
        {secondary.length > 0 && (
          <option value={OTHER_CONTIGS_VALUE} data-testid="chrom-selector-other">
            Other contigs ({secondary.length.toLocaleString()})…
          </option>
        )}
      </select>
      {pickerOpen && (
        <OtherContigsPicker
          contigs={secondary}
          onPick={name => { setPickerOpen(false); go(name); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </span>
  );
}

/** The searchable list of secondary contigs (Escape or a click outside closes it). */
function OtherContigsPicker({ contigs, onPick, onClose }: {
  contigs: ChromInfo[];
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? contigs.filter(c => c.name.toLowerCase().includes(q)) : contigs;
  }, [contigs, query]);
  const shown = matches.slice(0, PICKER_LIMIT);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);
  useEffect(() => {
    const item = listRef.current?.querySelector(`[data-index="${active}"]`) as HTMLElement | null;
    item?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Other contigs"
      data-testid="chrom-other-picker"
      className="absolute left-0 top-full z-50 mt-1 w-64 rounded-fb border border-line bg-white p-1.5 shadow-lg dark:border-white/10 dark:bg-dark-surface"
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      }}
    >
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(shown.length - 1, i + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
          else if (e.key === 'Enter') {
            e.preventDefault();
            const pick = shown[active];
            if (pick) onPick(pick.name);
          }
        }}
        placeholder={`Search ${contigs.length.toLocaleString()} other contigs`}
        aria-label="Search other contigs"
        aria-controls="chrom-other-list"
        aria-activedescendant={shown[active] ? `chrom-other-${active}` : undefined}
        data-testid="chrom-other-search"
        className="w-full rounded-fb border border-line px-1.5 py-0.5 text-xs text-gray-700 focus:border-brand-400 focus:outline-none dark:border-white/10 dark:bg-dark-surface dark:text-gray-200"
      />
      <ul id="chrom-other-list" ref={listRef} role="listbox" aria-label="Other contigs" className="mt-1 max-h-60 overflow-y-auto text-xs">
        {shown.map((c, i) => (
          <li
            key={c.name}
            id={`chrom-other-${i}`}
            data-index={i}
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => setActive(i)}
            onMouseDown={e => { e.preventDefault(); onPick(c.name); }}
            className={`flex cursor-pointer justify-between gap-2 rounded px-1.5 py-0.5 ${i === active ? 'bg-brand-50 text-brand-800 dark:bg-white/10 dark:text-white' : 'text-gray-700 dark:text-gray-300'}`}
          >
            <span className="truncate">{c.name}</span>
            <span className="shrink-0 text-gray-400">{formatSize(c.size)}</span>
          </li>
        ))}
        {matches.length === 0 && <li className="px-1.5 py-1 text-gray-400">No contig matches</li>}
        {matches.length > shown.length && (
          <li className="px-1.5 py-1 text-[11px] text-ink-secondary">{(matches.length - shown.length).toLocaleString()} more; type to narrow</li>
        )}
      </ul>
    </div>
  );
}
