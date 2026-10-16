/**
 * Accessibility (preview): the motif view of one saved NFR, observation first.
 *
 * The motif map (MotifMap) shows the variants' open spans, the shown families' sites as ticks, and per site and
 * variant one number: coverage (the share of the variant's reads whose own opening covers the site). Shown: the pinned
 * factors with a site here, plus the families a search matches. Under it, one table: per motif family and variant, the
 * sites inside the variant's span (pinned first; every family on request; a star pins one onto the map). One test per
 * site, "Coverage differs (q)", sits behind Details; ChIP-Atlas behind its own disclosure.
 */
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getNfrConservation, getNfrMotifs, parseMotifs, type MotifFamily, type MotifOptions, type NfrMotifs as NfrMotifsData } from '../api';
import { useBrowserStore } from '../../../stores/browserStore';
import { useAccessibilityStore } from '../accessibilityStore';
import { bp, formatQ, variantColor } from '../accessibilityView';
import { startJob, useJob } from '../nfrJobs';
import { showFootprintClass } from '../../../utils/panelLinks';
import { formatP } from '../../../utils/motifSettings';
import { AnalysisStatus, MotifPinBar } from '../../../components/controls/shared';
import { Pin } from '../../../components/ui/Icons';
import { DisclosureChevron } from '../../../components/ui/Disclosure';
import { motifLabel } from './NfrCharts';
import { NfrChipAtlas } from './NfrChipAtlas';
import { COVER_TEST_HELP, COVER_TEST_LABEL, COVERAGE_HELP, coverageOf, footprintOf, MARKER_MIN_COVERAGE, MotifMap, useFamilyColors, type MapFamily, type MapSite } from './MotifMap';
import { NfrJobOwnerContext, useView } from './useNfrView';

/** Families a search adds to the map at most (the table lists them all). */
export const SEARCH_MAP_ROWS = 8;

/** A pin-box entry that is a motif rather than a name: an IUPAC consensus (6+ letters of ACGT and the IUPAC codes,
 * at least two of them A/C/G/T) or a pasted matrix (several lines, or a row of numbers). Names with digits (NRF1,
 * Ibf1, BEAF-32) are names. */
export function looksLikeMotif(text: string): boolean {
  const t = text.trim();
  if (/\n/.test(t) || (t.match(/(?:^|[\s[\],;:|])\d+(?:\.\d+)?(?=$|[\s[\],;:|])/g)?.length ?? 0) >= 3) return true;
  return /^[ACGTRYSWKMBDHVN]{6,}$/i.test(t) && (t.match(/[ACGT]/gi)?.length ?? 0) >= 2 && t === t.toUpperCase();
}

/** A name as compared for lookups: case, accents and punctuation ignored ('Su(Hw)' = 'su(hw)' = 'suhw'), as the
 * server's motif_key. */
export function motifKey(name: string | null | undefined): string {
  return (name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/** The family a pinned name stands for: pinned under that name, else holding a matrix the name resolved to (a name
 * pinned twice, GAF after Trl, shows the first's family). */
export function familyForPin(data: NfrMotifsData, name: string): MotifFamily | undefined {
  const ids = data.pinned.resolved[name] ?? [];
  return data.families.find(r => r.pinned.includes(name)) ?? data.families.find(r => r.members.some(m => ids.includes(m.id)));
}

/** "p ≤ 1e−4" or "≥ 80% of each matrix's score range": the threshold the sites are called at. */
export function thresholdText(data: NfrMotifsData): string {
  return data.threshold.mode === 'relative' ? `≥ ${Math.round((data.threshold.relative ?? 0) * 100)}% of the score range` : `p ≤ ${formatP(data.threshold.p ?? 0)}`;
}

/** Pinned names with no site in the window at the threshold (resolved, so a matrix was scanned), in pinned order. */
export function zeroSitePins(data: NfrMotifsData): string[] {
  const missing = new Set(data.pinned.missing);
  return data.pinned.requested.filter(n => !missing.has(n) && !(familyForPin(data, n)?.sites.length));
}

/** A pinned name and what it resolved to when that differs ("Su(Hw) (su(Hw))"). */
export function pinLabel(data: NfrMotifsData, name: string): string {
  const names = data.pinned.names?.[name] ?? [];
  return names.length && !names.some(x => x === name) ? `${name} (${names.join(', ')})` : name;
}

export function matchesFamily(r: MotifFamily, needle: string): boolean {
  if (!needle) return true;
  return [r.name, r.common, r.id, ...r.members.flatMap(m => [m.name, m.id, m.common])]
    .some(x => !!x && x.toLowerCase().includes(needle));
}

/** Sites of a family inside each variant's span (its typical opening). */
export function sitesInside(r: MotifFamily, names: string[]): Record<string, number> {
  return Object.fromEntries(names.map(n => [n, r.sites.filter(s => s.in.includes(n)).length]));
}

/** The pinned position of a family in the requested list (999: not pinned). */
function pinOrder(r: MotifFamily, requested: string[]): number {
  const order = requested.map(s => s.toLowerCase());
  return Math.min(999, ...r.pinned.map(pn => order.indexOf(pn.toLowerCase())).filter(i => i >= 0));
}

/** The families on the map: the pinned ones with a site in the window (in pinned order), then, while searching, the
 * first families the search matches. Each keeps its colour slot by that order. */
export function mapFamilies(data: NfrMotifsData, needle: string): MotifFamily[] {
  const pinned = data.families.filter(r => r.pinned.length && r.sites.length && matchesFamily(r, needle))
    .sort((a, b) => pinOrder(a, data.pinned.requested) - pinOrder(b, data.pinned.requested));
  if (!needle) return pinned;
  const found = data.families.filter(r => !r.pinned.length && r.sites.length && matchesFamily(r, needle))
    .sort((a, b) => b.sites.length - a.sites.length || a.name.localeCompare(b.name)).slice(0, SEARCH_MAP_ROWS);
  return [...pinned, ...found];
}

/** The map's sites: every site of the shown families, in genomic order. */
export function mapSites(families: MapFamily[]): MapSite[] {
  return families.flatMap(f => f.family.sites.map(site => ({ family: f.family, site, color: f.color })))
    .sort((a, b) => a.site.start - b.site.start || a.family.name.localeCompare(b.family.name));
}

type SortKey = { key: string; dir: 1 | -1 };

/** The summary table's order: pinned first, then by the sort column (sites, a variant's sites inside, or name). */
export function sortFamilies(rows: MotifFamily[], sort: SortKey, names: string[], requested: string[]): MotifFamily[] {
  const value = (r: MotifFamily): number | string => (sort.key === 'name' ? r.name.toLowerCase()
    : sort.key === 'sites' ? r.sites.length : sitesInside(r, names)[sort.key] ?? 0);
  return [...rows].sort((a, b) => {
    const pa = a.pinned.length ? 0 : 1, pb = b.pinned.length ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const va = value(a), vb = value(b);
    if (va !== vb) return (va < vb ? -1 : 1) * sort.dir;
    if (pa === 0) return pinOrder(a, requested) - pinOrder(b, requested);
    return a.name.localeCompare(b.name);
  });
}

export function NfrMotifs({ jobId, nfrId, names, width, datasetIds = [] }: {
  jobId: string; nfrId: string;
  /** The run's datasets (to open a footprint class in the Footprints panel). */
  datasetIds?: string[];
  /** The variants to show (in order; empty: all); the test is over all of the NFR's variants. */
  names: string[];
  width: number;
}) {
  const { pinnedStore, setPinned, mode, pValue, relative, settings, custom, setCustom } = useBrowserStore(useShallow(s => ({
    pinnedStore: s.pinnedMotifs, setPinned: s.setPinnedMotifs, mode: s.motifScoreMode, pValue: s.motifPValue,
    relative: s.motifThreshold, settings: s.nfrMotifSettings, custom: s.customMotifs, setCustom: s.setCustomMotifs,
  })));
  const [species, setSpecies] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  // A name just pinned: once the rescan answers, say what it found (sites here, none at the threshold, not in JASPAR).
  const [justPinned, setJustPinned] = useState<{ name: string; prefix: string } | null>(null);
  // A name just pinned that has no site here at the threshold (said once, in the zero-hit line).
  const [zeroPinned, setZeroPinned] = useState<string | null>(null);
  const [zeroLead, setZeroLead] = useState<string | null>(null);
  const pinned = species ? pinnedStore[species] : undefined;
  const setMotifSpecies = useAccessibilityStore(s => s.setMotifSpecies);
  const options: MotifOptions = useMemo(() => ({
    ...(mode === 'relative' ? { mode, relative } : { mode, p: pValue }),
    background: settings.background, strand: settings.strand, family_similarity: settings.familySimilarity, flank: settings.flank,
    core_bp: settings.coreBp, min_reads: settings.minReads,
    ...(custom.length ? { custom } : {}), ...(pinned ? { pinned } : {}),
  }), [mode, pValue, relative, settings, custom, pinned]);
  const classRevision = useAccessibilityStore(s => s.classRevision);
  // A genome declared for the run's reference: its species' motifs (the server keys its cache on it too).
  const referenceRevision = useBrowserStore(s => s.referenceRevision);
  const key = `${jobId}|${nfrId}|${JSON.stringify(options)}|c${classRevision}|r${referenceRevision}`;
  const { data: fresh, error, loading } = useView<NfrMotifsData>(() => getNfrMotifs(jobId, nfrId, options), key, `Motifs of ${nfrId}`);
  // While a rescan (new pins, settings or class revision) runs, this NFR's last answer stays on screen.
  const last = useRef<{ key: string; data: NfrMotifsData } | null>(null);
  const nfrKey = `${jobId}|${nfrId}`;
  if (fresh) last.current = { key: nfrKey, data: fresh };
  const data = fresh ?? (last.current?.key === nfrKey ? last.current.data : null);
  // A cached answer without a footprint layer: ask once more on opening (a Find classes run may have joined since).
  const askedAgain = useRef(false);
  useEffect(() => {
    if (!fresh || askedAgain.current || !fresh.occupancy?.available || fresh.occupancy.classes) return;
    askedAgain.current = true;
    useAccessibilityStore.getState().bumpClassRevision();
  }, [fresh]);
  // The species decides which pinned list applies (known from the first answer); the panel's settings strip pins there.
  useEffect(() => {
    const sp = data ? (data.pinned.species ?? 'other') : null;
    if (sp && sp !== species) setSpecies(sp);
    if (sp) setMotifSpecies(sp, data!.pinned.defaults);
  }, [data, species, setMotifSpecies]);
  useEffect(() => {
    if (!justPinned || !fresh || !fresh.pinned.requested.includes(justPinned.name)) return;
    setJustPinned(null);
    const { name: n, prefix } = justPinned;
    if (fresh.pinned.missing.includes(n)) {
      const iupac = /^[ACGTRYSWKMBDHVN]{6,}$/i.test(n) && n !== n.toUpperCase();
      setNotice({ ok: false, text: `${prefix}${n}: not found in JASPAR CORE${fresh.species?.name ? ` (${fresh.species.name})` : ''}${iupac ? '; type a consensus in capitals (e.g. CAGGTAG) to add it as your own motif' : ''}` });
      return;
    }
    const f = familyForPin(fresh, n);
    // none here at the threshold: the zero-hit line (with Relax threshold) says it, not a second message
    if (f?.sites.length) setNotice({ ok: true, text: `${prefix}${pinLabel(fresh, n)}: ${f.sites.length} site${f.sites.length === 1 ? '' : 's'} here, on the map` });
    else { setNotice(null); setZeroPinned(n); setZeroLead(prefix ? prefix.replace(/: $/, '') : null); }
  }, [fresh, justPinned]);
  const colors = useFamilyColors();
  const needle = query.trim().toLowerCase();
  const shown = data ? (names.length ? names.filter(n => data.variants.includes(n)) : data.variants) : names;
  const hasClasses = !!data?.occupancy?.classes;
  const families: MapFamily[] = useMemo(() => (data ? mapFamilies(data, needle) : [])
    .map((family, i) => ({ family, color: colors[i] ?? '#8b93a1' })), [data, needle, colors]);
  const sites = useMemo(() => mapSites(families), [families]);

  const pinList = data?.pinned.requested ?? [];
  const sp = species ?? 'other';
  /** A name pins a JASPAR (or custom) motif; a consensus or a pasted matrix becomes a custom motif, pinned and scored. */
  const addPin = async (raw?: string) => {
    const text = (raw ?? query).trim();
    if (!text) return;
    setNotice(null);
    setZeroPinned(null);
    setZeroLead(null);
    if (!looksLikeMotif(text)) {
      // a family listed here under any spelling (Su(Hw) / su(Hw), GAF / Trl, Zelda / vfl): its JASPAR name; else the
      // name as typed (the server resolves case, punctuation, common names and aliases)
      const k = motifKey(text);
      const family = data?.families.find(r => [r.name, r.common, ...r.members.flatMap(m => [m.name, m.common])].some(x => !!x && motifKey(x) === k));
      const name = family?.name ?? text;
      const already = pinList.find(x => motifKey(x) === motifKey(name) || (family && familyForPin(data!, x)?.id === family.id));
      if (already) {
        if (family && !family.sites.length) setZeroPinned(already);
        else setNotice({ ok: true, text: `${pinLabel(data!, already)} is pinned already` });
      }
      else { setPinned(sp, [...pinList, name]); setJustPinned({ name, prefix: '' }); setNotice({ ok: true, text: `Pinned ${name}: scanning…` }); }
      setQuery('');
      return;
    }
    try {
      const single = !/\n/.test(text);
      const { motifs } = await parseMotifs(text, single ? text.toUpperCase() : undefined);
      if (!motifs.length) throw new Error('No motif found in the text');
      setCustom([...custom.filter(c => !motifs.some(m => m.name.toLowerCase() === c.name.toLowerCase())), ...motifs]);
      const added = motifs.map(m => m.name).filter(n => !pinList.some(x => x.toLowerCase() === n.toLowerCase()));
      setPinned(sp, [...pinList, ...added]);
      const msg = `Added ${motifs.map(m => `${m.name} (${m.counts.A.length} bp)`).join(', ')}, pinned`;
      setJustPinned(added.length === 1 ? { name: added[0], prefix: `${msg}: ` } : null);
      setQuery('');
      setNotice({ ok: true, text: msg });
    } catch (e) {
      setNotice({ ok: false, text: `Not a motif: ${String((e as Error).message ?? e)}` });
    }
  };
  const togglePin = (r: MotifFamily) => {
    if (r.pinned.length) setPinned(sp, pinList.filter(x => !r.pinned.includes(x)));
    else setPinned(sp, [...pinList, r.name]);
  };

  const summaryTitle = data ? `${data.species ? `JASPAR CORE (${data.species.name ?? data.species.genome}): ` : ''}${data.scanned.toLocaleString()} matrices over ${bp(data.window[0])}–${bp(data.window[1])} `
    + `${data.threshold.mode === 'relative' ? `at ≥ ${Math.round((data.threshold.relative ?? 0) * 100)}% of each matrix's score range` : `at p ≤ ${formatP(data.threshold.p ?? 0)}`} `
    + `(${data.threshold.background} background)` : '';
  const nSites = data ? data.families.reduce((n, f) => n + f.sites.length, 0) : 0;
  // One message for "nothing here": the searched or pinned motifs with no site at the threshold, with Relax threshold.
  const zeroHits = useMemo(() => {
    if (!data) return [];
    const defaults = new Set([...data.pinned.defaults, ...(data.pinned.retired ?? [])].map(motifKey));
    if (needle) {
      const pinnedZero = zeroSitePins(data).filter(n => motifKey(n).includes(motifKey(needle)));
      const anySites = data.families.some(r => r.sites.length && matchesFamily(r, needle));
      return pinnedZero.length ? pinnedZero.map(n => pinLabel(data, n)) : anySites ? [] : [query.trim()];
    }
    const own = zeroSitePins(data).filter(n => !defaults.has(motifKey(n)));
    const names = zeroPinned && !own.includes(zeroPinned) && zeroSitePins(data).includes(zeroPinned) ? [zeroPinned, ...own] : own;
    return names.map(n => pinLabel(data, n));
  }, [data, needle, query, zeroPinned]);
  const quiet = data ? new Set([...data.pinned.defaults, ...(data.pinned.retired ?? [])].map(motifKey)) : new Set<string>();
  const missingOwn = data ? data.pinned.missing.filter(n => !quiet.has(motifKey(n))) : [];
  const unavailable = data ? data.pinned.missing.filter(n => quiet.has(motifKey(n))) : [];
  const missingNotice = missingOwn.length ? { ok: false, text: `Not in JASPAR CORE${data?.species?.name ? ` (${data.species.name})` : ''}: ${missingOwn.join(', ')}` } : null;
  const withSite = data ? data.families.filter(r => r.pinned.length && r.sites.length).length : 0;
  return (
    <div className="space-y-2" data-testid="nfr-motifs-view">
      <MotifPinBar testIdPrefix="nfr-motif" query={query} onQuery={q => { setQuery(q); setZeroPinned(null); setZeroLead(null); setNotice(null); }} onPin={t => void addPin(t)} onPasteBlock={t => void addPin(t)}
        pinned={pinList} onUnpin={name => setPinned(sp, pinList.filter(x => x !== name))} onReset={pinned ? () => setPinned(sp, null) : undefined}
        pinnedSummary={data ? `${withSite} with a site here` : undefined}
        chipTitle={name => { if (!data) return undefined; const row = familyForPin(data, name); return data.pinned.substituted[name] ? `${name}: no ${data.species?.name ?? ''} matrix; the ${data.pinned.substituted[name]} one` : row?.sites.length ? `${row.sites.length} site(s) here` : `0 sites here at ${thresholdText(data)}`; }}
        chipFaint={name => !!data && !familyForPin(data, name)?.sites.length}
        zeroHits={zeroHits} zeroLead={needle ? null : zeroLead} notice={notice ?? missingNotice} unavailable={unavailable}
        pinsNote={`kept per species (${sp}) and with the session`}
        extra={data && <span className="text-ink-muted" data-testid="nfr-motif-summary" title={summaryTitle}>{nSites} sites · {data.with_sites} families</span>} />
      {loading && !data && <AnalysisStatus kind="loading">Scanning the NFR for motifs…</AnalysisStatus>}
      {loading && data && <p className="text-[11px] text-ink-muted" data-testid="nfr-motif-rescanning">Rescanning…</p>}
      {error && <AnalysisStatus kind="error">{error}</AnalysisStatus>}
      {data && (
        <>
          {sites.length > 0
            ? <MotifMap families={families} sites={sites} spans={data.spans} names={shown} window={data.window} width={width} hasClasses={hasClasses} fileStem={nfrId} />
            : !needle && !zeroHits.length && <p className="text-[11px] text-gray-600 dark:text-gray-300" data-testid="nfr-motif-map-empty">No pinned factor has a site here at {thresholdText(data)}: pin a family below, or search.</p>}
          <SummaryTable data={data} names={shown} needle={needle} onPin={togglePin} quietEmpty={zeroHits.length > 0} />
          <Details sites={sites} names={shown} data={data} jobId={jobId} datasetIds={datasetIds} flank={settings.flank} hasClasses={hasClasses} />
          <details className="rounded-md border border-gray-200 px-2 py-1 text-[11px] dark:border-gray-700" data-testid="nfr-chipatlas-disclosure">
            <summary className="cursor-pointer text-gray-600 dark:text-gray-300" title="ChIP-Atlas peaks of the pinned factors over the variants, from experiments that match your samples">ChIP-Atlas</summary>
            <div className="mt-1.5"><NfrChipAtlas data={data} jobId={jobId} names={shown} width={width} datasetIds={datasetIds} /></div>
          </details>
          {data.warnings.map(wn => <AnalysisStatus key={wn} kind="info">{wn}</AnalysisStatus>)}
        </>
      )}
    </div>
  );
}

/** Per motif family and variant: the sites inside the variant's span. Pinned first; the rest on request. */
function SummaryTable({ data, names, needle, onPin, quietEmpty }: { data: NfrMotifsData; names: string[]; needle: string; onPin: (r: MotifFamily) => void; quietEmpty?: boolean }) {
  const [sort, setSort] = useState<SortKey>({ key: 'sites', dir: -1 });
  const [all, setAll] = useState(false);
  const rows = useMemo(() => sortFamilies(data.families.filter(r => r.sites.length && matchesFamily(r, needle)), sort, names, data.pinned.requested),
    [data, needle, sort, names.join('|')]);
  const pinnedRows = rows.filter(r => r.pinned.length);
  const others = rows.filter(r => !r.pinned.length);
  const listed = all || needle ? rows : pinnedRows;
  // Pinned families with no site here: one row each for the ones you pinned (the species' defaults are in the note
  // under the map), saying so at the threshold.
  const defaults = new Set(data.pinned.defaults.map(motifKey));
  const zeroRows = zeroSitePins(data).filter(n => !defaults.has(motifKey(n)) && (!needle || motifKey(n).includes(motifKey(needle))));
  const head = (key: string, label: string, title: string, color?: string) => (
    <th key={key} className="font-medium" style={color ? { color } : undefined} title={title} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1 }))} data-testid={`nfr-motif-sort-${key}`}
        className="hover:underline">{label}{sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</button>
    </th>
  );
  return (
    <div className="space-y-1" data-testid="nfr-motif-summary-table">
      <table className="min-w-[20rem] text-[11px] tabular-nums" data-testid="nfr-motif-table">
        <thead className="text-left text-gray-500">
          <tr>
            <th className="w-4" />
            {head('name', 'Motif', 'Motif family (similar matrices hitting the same bases)')}
            {head('sites', 'Sites', 'Sites in the window')}
            {names.map(n => head(n, n, `Sites inside ${n}'s span (its typical opening)`, variantColor(n)))}
          </tr>
        </thead>
        <tbody>
          {listed.map(r => {
            const inside = sitesInside(r, names);
            const pinned = r.pinned.length > 0;
            return (
              <tr key={r.id} className="border-t border-gray-100 dark:border-white/5" data-testid="nfr-motif-row" data-motif={r.name} data-pinned={pinned ? '1' : '0'}>
                <td>
                  <button type="button" onClick={() => onPin(r)} aria-label={pinned ? `Unpin ${r.name}` : `Pin ${r.name}`} aria-pressed={pinned} title={pinned ? 'Pinned: click to unpin (off the map)' : 'Pin (onto the map)'}
                    data-testid="nfr-motif-star" className={`inline-flex h-4 w-4 items-center justify-center rounded leading-none ${pinned ? 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-200' : 'text-ink-secondary hover:text-fuchsia-600 dark:text-gray-500'}`}>
                    <Pin size={11} aria-hidden="true" /></button>
                </td>
                <td className="pr-6" title={r.members.map(m => `${m.name}${m.common ? ` (${m.common})` : ''} ${m.id}, ${m.length} bp`).join('\n')}>
                  <span className={pinned ? 'font-semibold' : ''}>{motifLabel(r)}</span>
                  {r.members.length > 1 && <span className="ml-1 text-[10px] text-ink-secondary">+{r.members.length - 1}</span>}
                </td>
                <td className="pr-4 text-gray-500">{r.sites.length}</td>
                {names.map(n => <td key={n} className={`pr-4 ${inside[n] ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-gray-300 dark:text-gray-600'}`} data-variant={n}>{inside[n]}</td>)}
              </tr>
            );
          })}
          {zeroRows.map(n => (
            <tr key={`zero-${n}`} className="border-t border-gray-100 dark:border-white/5" data-testid="nfr-motif-row" data-motif={familyForPin(data, n)?.name ?? n} data-pinned="1" data-sites="0">
              <td><span className="inline-flex h-4 w-4 items-center justify-center rounded bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-200" aria-label="pinned"><Pin size={11} aria-hidden="true" /></span></td>
              <td className="pr-6 font-semibold">{pinLabel(data, n)}</td>
              <td className="text-gray-500" colSpan={1 + names.length} data-testid="nfr-motif-zero-row">0 sites here at {thresholdText(data)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!needle && others.length > 0 && (
        <button type="button" onClick={() => setAll(v => !v)} data-testid="nfr-motif-show-all" aria-expanded={all}
          className="flex items-center gap-1 text-[11px] text-fuchsia-700 hover:underline dark:text-fuchsia-300">
          <DisclosureChevron open={all} /> {all ? 'Pinned only' : `Show all families (${others.length} more)`}
        </button>
      )}
      {!listed.length && !zeroRows.length && !quietEmpty && <p className="text-[11px] text-gray-500">{needle ? 'No family with a site here matches.' : 'No pinned factor has a site here.'}</p>}
    </div>
  );
}

/** Mean of a per-base track over [a, b) of a window starting at ``lo`` (null when no value). */
export function meanOver(values: (number | null)[], lo: number, a: number, b: number): number | null {
  const xs: number[] = [];
  for (let x = Math.max(lo, Math.floor(a)); x < Math.min(lo + values.length, Math.ceil(b)); x++) {
    const v = values[x - lo];
    if (v != null) xs.push(v);
  }
  return xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : null;
}

const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);

/** The map's sites as numbers, with the one test per site; conservation and footprint classes on request. */
function Details({ sites, names, data, jobId, datasetIds, flank, hasClasses }: {
  sites: MapSite[]; names: string[]; data: NfrMotifsData; jobId: string; datasetIds: string[]; flank: number; hasClasses: boolean;
}) {
  const qMax = useAccessibilityStore(s => s.qMax);
  const consKey = `cons|${jobId}|${data.nfr}|${flank}`;
  const consJob = useJob<{ track: string; window: [number, number]; values: (number | null)[] }>(consKey);
  const cons = consJob?.status === 'done' ? consJob.data : null;
  const owner = useContext(NfrJobOwnerContext);
  const loadCons = () => startJob(consKey, () => getNfrConservation(jobId, data.nfr, flank), { ...(owner ?? {}), label: `Conservation · ${owner?.label ?? data.nfr}` });
  const classJob = data.occupancy?.class_job ?? null;
  const testHelp = `${COVER_TEST_HELP}${data.occupancy?.definitions?.cover_test ? `\n\n${data.occupancy.definitions.cover_test}` : ''}`;
  if (!sites.length) return null;
  return (
    <details className="rounded-md border border-gray-200 px-2 py-1 text-[11px] dark:border-gray-700" data-testid="nfr-motif-details">
      <summary className="cursor-pointer text-gray-600 dark:text-gray-300" title="The map's sites as numbers, and whether coverage differs between the variants">Details</summary>
      <div className="mt-1.5 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          {!cons && (
            <button type="button" onClick={loadCons} disabled={consJob?.status === 'loading'} data-testid="nfr-sites-conservation"
              className="rounded px-1.5 text-teal-700 hover:bg-teal-50 disabled:opacity-50 dark:text-teal-300 dark:hover:bg-teal-900/30"
              title="Read UCSC's phyloP over this window (a small remote read): each site against its flanks">
              {consJob?.status === 'loading' ? 'Reading phyloP…' : '+ phyloP'}
            </button>
          )}
          {consJob?.status === 'error' && <span className="text-red-600 dark:text-red-400">{consJob.error}</span>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full tabular-nums" data-testid="nfr-sites-table">
            <thead className="text-left text-gray-500">
              <tr>
                <th className="font-medium">Site</th>
                {names.map(n => <th key={n} className="font-medium" style={{ color: variantColor(n) }} title={COVERAGE_HELP}>{n}</th>)}
                <th className="font-medium" title={testHelp} data-testid="nfr-cover-test-head">{COVER_TEST_LABEL}</th>
                {hasClasses && <th className="font-medium" title="Footprint class over the site core (Find classes)">class</th>}
                {cons && <th className="font-medium" title={`${cons.track}: mean over the site / over 50 bp on each side`}>phyloP</th>}
              </tr>
            </thead>
            <tbody>
              {sites.map(({ family, site }) => {
                const q = site.q_cover_diff;
                return (
                  <tr key={`${family.id}-${site.start}-${site.strand}`} className="border-t border-gray-100 dark:border-white/5" data-testid="nfr-site-row" data-motif={family.name} data-start={site.start}>
                    <td className="pr-2" title={`${motifLabel(family)} at ${bp(site.start)} (${site.strand}), p ${site.p.toExponential(1)}`}>
                      {family.name} <span className="text-[10px] text-ink-secondary">{bp(site.start)}</span>
                    </td>
                    {names.map(n => {
                      const c = site.coverage?.[n];
                      const cv = coverageOf(site, n);
                      const fp = hasClasses && cv != null && cv >= MARKER_MIN_COVERAGE ? footprintOf(site, n) : null;
                      return (
                        <td key={n} className="pr-2" data-testid="nfr-site-cover" data-variant={n}
                          title={c && c.n ? `${n}: ${c.covered} of ${c.n} reads${c.ci ? ` (95% interval ${pct(c.ci[0])}–${pct(c.ci[1])})` : ''}${fp != null ? `; footprinted when open ${pct(fp)}` : ''}` : 'no reads'}>
                          {pct(cv)}{fp != null && <span className="ml-0.5 text-[10px] text-ink-secondary">●{pct(fp)}</span>}
                        </td>
                      );
                    })}
                    <td className={`pr-2 ${q != null && q <= qMax ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-ink-secondary'}`} title={testHelp} data-testid="nfr-site-q-cover">{q == null ? '–' : formatQ(q)}</td>
                    {hasClasses && (
                      <td className="pr-2 text-[10px] text-gray-500" data-testid="nfr-site-classes">{site.classes?.length ? site.classes.map(c => (
                        classJob && datasetIds.length
                          ? <button key={c.id} type="button" className="mr-1 text-emerald-700 hover:underline dark:text-emerald-300" data-testid="nfr-site-class"
                            onClick={() => showFootprintClass(classJob, c.id, datasetIds)} title="Open this class in the Footprints panel">{c.label.replace(/^class /, 'C')} ↗</button>
                          : <span key={c.id} className="mr-1">{c.label}</span>)) : '–'}</td>
                    )}
                    {cons && (() => {
                      const m = meanOver(cons.values, cons.window[0], site.start, site.end);
                      const f = [meanOver(cons.values, cons.window[0], site.start - 50, site.start), meanOver(cons.values, cons.window[0], site.end, site.end + 50)].filter((v): v is number => v != null);
                      const fm = f.length ? f.reduce((p, q2) => p + q2, 0) / f.length : null;
                      return <td className="whitespace-nowrap pr-2 text-gray-500" data-testid="nfr-site-phylop" title="Mean phyloP over the site / over 50 bp on each side">{m == null ? '–' : m.toFixed(1)} / {fm == null ? '–' : fm.toFixed(1)}</td>;
                    })()}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}
