/**
 * "Identify this insertion": pure view logic (no React).
 *
 * The backend (/api/insertions/identify, services/insertion_identify.py) searches
 * the lens consensus against the loaded genome and a downloaded TE library and
 * returns calls, loci, genes and a tiling of the consensus into segments, all
 * in consensus coordinates (0-based, half-open). This module turns that into
 * the summary, the hit tables, the cartoon's shapes (to scale along the insert,
 * mirrored when the lens is reversed) and the slim copy saved with sessions.
 */

export interface TeFeature { type: string; label: string; qstart: number; qend: number; partial?: boolean }

export interface TeCall {
  family: string; class: string; subclass: string; class_label: string; strand: '+' | '-';
  identity: number; query: [number, number][]; qstart: number; qend: number;
  element_length: number; element_start: number; element_end: number; element_coverage: number;
  query_coverage: number; completeness: string; five_missing: number; three_missing: number;
  bitscore: number; evalue: number | null; related: boolean; description?: string;
  mapped_features?: TeFeature[]; poly_a?: { qstart: number; qend: number } | null;
}

export interface GenomeLocus {
  chrom: string; strand: '+' | '-'; start: number; end: number; qstart: number; qend: number;
  qcov: number; identity: number; evalue: number | null; bitscore: number; near_site: number | null;
  rmsk?: { name: string; class: string; family: string; class_label: string; fraction: number };
  n_hsps?: number;
}

/** A genome copy of the insert (0-based, end exclusive). */
export interface ReferenceCopy {
  chrom: string; start: number; end: number; strand: '+' | '-'; identity: number; qcov: number;
  rmsk?: GenomeLocus['rmsk'];
}

/** Loci covering this share of the insert are copies of it (services/insertion_identify.COPY_QCOV). */
export const COPY_QCOV = 0.5;

/**
 * "Open the reference copies": the insert's best copies in the genome, as the server picks them
 * (reference_copies), or from the loci of a result saved before it did: at least half the insert,
 * not at the insertion's own site, one per place, best first.
 */
export function referenceCopies(genome: IdentifyResult['genome'], n: number): ReferenceCopy[] {
  if (genome.reference_copies) return genome.reference_copies.slice(0, Math.max(0, n));
  const out: ReferenceCopy[] = [];
  const sorted = [...genome.loci].sort((a, b) => (b.bitscore - a.bitscore) || (b.identity - a.identity));
  for (const l of sorted) {
    if (out.length >= n) break;
    if (l.qcov < COPY_QCOV || l.near_site !== null) continue;
    if (out.some(p => p.chrom === l.chrom && p.start < l.end && l.start < p.end)) continue;
    out.push({ chrom: l.chrom, start: l.start, end: l.end, strand: l.strand, identity: l.identity, qcov: l.qcov, ...(l.rmsk ? { rmsk: l.rmsk } : {}) });
  }
  return out;
}

/** The family name for the copies' panels: the TE call, else RepeatMasker's, else "insert". */
export function insertFamilyName(result: IdentifyResult): string {
  return result.te.calls.find(c => !c.related)?.family ?? result.genome.rmsk_family?.name ?? 'insert';
}

export interface GeneHit {
  gene: string; transcript: string; strand: string; chrom: string; gene_start: number; gene_end: number;
  exons: number[]; n_exons: number; exonic_bp: number; intronic_bp: number; query: [number, number][];
  identity: number; spliced: boolean;
  /** 'gene': the annotation has no exon rows, so only a gene-body overlap is known. */
  region: 'exon' | 'intron' | 'gene';
  /** The gene's direction along the consensus (``strand`` is its reference strand). */
  orientation?: '+' | '-';
}

export interface Segment {
  kind: 'te' | 'gene' | 'local' | 'repeat' | 'genomic' | 'tsd' | 'polyA' | 'unknown';
  qstart: number; qend: number; label: string;
  class?: string | null; class_label?: string; strand?: string | null; identity?: number | null;
  completeness?: string; gene?: string; spliced?: boolean; copies?: number | null;
}

export interface LibraryInfo {
  id: string; label: string; source?: string; licence: string; licence_url?: string; citation?: string;
  version?: string; homepage?: string;
}

/**
 * How sure an Identify result is (services/insertion_identify.py ``verdict``; docs/identify.md): what it offers is a
 * candidate, never an identification. Results saved before verdicts existed get one computed here, with the same
 * thresholds (keep the two in step).
 */
export interface IdentifyVerdict {
  status: 'candidate' | 'ambiguous' | 'no_match';
  /** Where the best candidate comes from. */
  source: 'te' | 'gene' | 'repeatmasker' | 'genome' | null;
  candidates: string[];
  reason: string;
  thresholds: { min_identity: number; min_query_coverage: number; ambiguous_bitscore_fraction: number; ambiguous_min_overlap: number };
}

/** A candidate needs at least this identity (%) ... */
export const VERDICT_MIN_IDENTITY = 80;
/** ... over at least this share of the insert. */
export const VERDICT_MIN_QUERY_COVERAGE = 0.5;
/** Another TE family within this share of the best bitscore, over the same bases, makes the result ambiguous ... */
export const AMBIGUOUS_BITSCORE_FRACTION = 0.05;
/** ... "the same bases": at least this share of the shorter call's insert bases shared. */
export const AMBIGUOUS_MIN_OVERLAP = 0.5;

export interface IdentifyResult {
  schema: string;
  /** How sure the result is (absent in results saved before 3.0: see identifyVerdict). */
  verdict?: IdentifyVerdict; length: number; seq_sha256: string; chrom: string | null; ref: number | null;
  engine: string; masking: string; summary: string; report: string; seconds: number | null;
  /** The reference and annotation it was computed against (compare with LibraryStatus.reference_id). */
  reference_id?: string;
  /** Set when the TE library could not be set up for this run (e.g. offline). */
  library_note?: string;
  /** The program that produced it ("BLAST+ 2.17.0+ (/opt/homebrew/bin/blastn)"). */
  tool?: { name: string; version: string | null; path: string | null; label: string };
  te: { library: LibraryInfo | null; calls: TeCall[] };
  genome: {
    assembly: string | null; loci: GenomeLocus[]; n_loci: number; copies: number; capped: boolean;
    genes: GeneHit[]; rmsk: 'off' | 'ok' | 'unavailable';
    rmsk_family: { name: string; class_label: string; class: string; loci: number } | null;
    /** The insert's best whole copies away from its site (services/insertion_identify.reference_copies); older results: from loci. */
    reference_copies?: ReferenceCopy[];
  };
  tsd: { length: number; seq: string; side: 'start' | 'end'; qstart: number; qend: number; confident: boolean } | null;
  segments: Segment[];
}

export interface IdentifyJob {
  job_id?: string; key?: string; status: 'idle' | 'running' | 'done' | 'error' | 'cancelled' | 'missing';
  message?: string; progress?: number; error?: string | null; result?: IdentifyResult | null;
}

export interface LibraryOption {
  id: string; label: string; short: string; source: string; homepage: string; licence: string; licence_url: string;
  citation: string; size_bytes: number; version: string; installed: boolean; families?: number | null;
  /** Its files ship with the app / WSL distribution: set up without a download. */
  bundled?: boolean;
}

export interface LibraryStatus {
  success: boolean; genome: string | null; libraries: LibraryOption[]; active: string | null;
  tools: {
    blastn: boolean; makeblastdb: boolean; minimap2: boolean;
    /** "BLAST+ 2.17.0+ (/opt/homebrew/bin/blastn)" or "BLAST+ not found". */
    blast_label?: string; blast_version?: string | null; blast_path?: string | null;
    minimap2_version?: string | null; minimap2_path?: string | null; hint?: string;
  };
  genome_loaded: boolean;
  /** The loaded reference + annotation now. */
  reference_id?: string;
}

export interface DfamHit {
  family: string; accession: string; type: string; description?: string; evalue: string; bitscore: string;
  strand: string; qstart: string; qend: string; model_start?: string; model_end?: string; model_length?: string;
}

/** One saved identification per insertion cluster (on the lens PanelConfig, so sessions carry it). */
export interface SavedIdentify { seqSha: string; at: string; result: IdentifyResult }

/** The key an identification is filed under: the dataset's insertion cluster. */
export function identifyClusterKey(t: { datasetId: string; chrom: string; ref?: number | null; len?: number | null; pos: number }): string {
  return `${t.datasetId}|${t.chrom}|${t.ref ?? t.pos}|${t.len ?? ''}`;
}

export const SAVED_LOCI = 50;
export const SAVED_MAX = 12;

/** The result as saved in a session: the table capped, nothing else lost. */
export function slimResult(result: IdentifyResult): IdentifyResult {
  return { ...result, genome: { ...result.genome, loci: result.genome.loci.slice(0, SAVED_LOCI) } };
}

/** Keep at most ``SAVED_MAX`` clusters' results (newest kept). */
export function addSaved(saved: Record<string, SavedIdentify> | undefined, key: string, entry: SavedIdentify): Record<string, SavedIdentify> {
  const next = { ...(saved ?? {}), [key]: entry };
  const keys = Object.keys(next).sort((a, b) => next[a].at.localeCompare(next[b].at));
  while (keys.length > SAVED_MAX) delete next[keys.shift()!];
  return next;
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text.toUpperCase());
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Colours (one per TE class; the cartoon and the tables)

export const CLASS_COLORS: Record<string, string> = {
  LTR: '#d97706',      // amber
  LINE: '#2563eb',     // blue
  SINE: '#0891b2',     // cyan
  DNA: '#16a34a',      // green
  RC: '#db2777',       // pink (Helitrons)
  Helitron: '#db2777',
  Unknown: '#64748b',
};
export const KIND_COLORS = {
  gene: '#7c3aed', local: '#0d9488', repeat: '#a16207', genomic: '#475569', tsd: '#334155', polyA: '#0284c7',
  unknown: '#94a3b8',
};

export function classKey(cls: string | null | undefined): string {
  const c = (cls ?? '').toUpperCase();
  if (c.startsWith('LTR')) return 'LTR';
  if (c.startsWith('LINE') || c === 'NON_LTR' || c.includes('NON-LTR')) return 'LINE';
  if (c.startsWith('SINE')) return 'SINE';
  if (c.startsWith('DNA') || c === 'TIR' || c === 'MITE') return 'DNA';
  if (c.startsWith('RC') || c.includes('HELITRON')) return 'RC';
  return 'Unknown';
}

export function segmentColor(seg: Pick<Segment, 'kind' | 'class'>): string {
  if (seg.kind === 'te') return CLASS_COLORS[classKey(seg.class)];
  if (seg.kind === 'repeat' && seg.class) return CLASS_COLORS[classKey(seg.class)];
  return KIND_COLORS[seg.kind as keyof typeof KIND_COLORS] ?? KIND_COLORS.unknown;
}

export const CLASS_LEGEND: { key: string; label: string }[] = [
  { key: 'LTR', label: 'LTR' }, { key: 'LINE', label: 'LINE' }, { key: 'SINE', label: 'SINE' },
  { key: 'DNA', label: 'DNA' }, { key: 'RC', label: 'Helitron' }, { key: 'Unknown', label: 'unclassified' },
];

// ---------------------------------------------------------------------------
// Summary / caption

/** The top call, when the library named one at >= 80% identity. */
export function topCall(result: IdentifyResult): TeCall | null {
  return result.te.calls.find(c => !c.related) ?? null;
}

const THRESHOLDS: IdentifyVerdict['thresholds'] = {
  min_identity: VERDICT_MIN_IDENTITY, min_query_coverage: VERDICT_MIN_QUERY_COVERAGE,
  ambiguous_bitscore_fraction: AMBIGUOUS_BITSCORE_FRACTION, ambiguous_min_overlap: AMBIGUOUS_MIN_OVERLAP,
};
const confident = (identity: number | null | undefined, qcov: number | null | undefined) =>
  (identity ?? 0) >= VERDICT_MIN_IDENTITY && (qcov ?? 0) >= VERDICT_MIN_QUERY_COVERAGE;
const familyKey = (c: Pick<TeCall, 'family'>) => c.family.replace(/\s*\(LTR\)$/, '').trim().toLowerCase();
const spanLength = (ivs: [number, number][]) => {
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of [...ivs].sort((x, y) => x[0] - y[0])) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
};
function queryOverlap(a: TeCall, b: TeCall): number {
  const ia = a.query?.length ? a.query : [[a.qstart, a.qend] as [number, number]];
  const ib = b.query?.length ? b.query : [[b.qstart, b.qend] as [number, number]];
  let shared = 0;
  for (const [x0, x1] of ia) for (const [y0, y1] of ib) shared += Math.max(0, Math.min(x1, y1) - Math.max(x0, y0));
  const shorter = Math.min(spanLength(ia), spanLength(ib));
  return shorter > 0 ? shared / shorter : 0;
}
const pct0 = (v: number) => `${Math.round(v * 100)}%`;

/** The result's verdict: the server's, else (a result saved before verdicts) computed the same way. */
/** RepeatMasker's most frequent name among the qualifying loci that carry one (services/insertion_identify._rmsk_candidate). */
function rmskCandidate(loci: GenomeLocus[]): { name: string; loci: number; locus: GenomeLocus } | null {
  const named = loci.filter(l => l.rmsk?.name);
  if (!named.length) return null;
  const votes = new Map<string, number>();
  for (const l of named) votes.set(l.rmsk!.name, (votes.get(l.rmsk!.name) ?? 0) + 1);
  let name = named[0].rmsk!.name;
  for (const l of named) if ((votes.get(l.rmsk!.name) ?? 0) > (votes.get(name) ?? 0)) name = l.rmsk!.name;
  return { name, loci: votes.get(name)!, locus: named.find(l => l.rmsk!.name === name)! };
}

/** The exonic gene that passes the minimums (the first one), with its share of the insert. */
function qualifyingGene(result: IdentifyResult): { gene: GeneHit; covered: number } | null {
  for (const gene of result.genome.genes) {
    if (gene.region !== 'exon') continue;
    const covered = spanLength(gene.query) / Math.max(1, result.length);
    if (confident(gene.identity, covered)) return { gene, covered };
  }
  return null;
}

/**
 * The verdict: the server's, else (results saved before it gave one) the same rules here. The best candidate is the
 * best-ranked one that passes the minimums; ambiguity is among the ones that pass.
 */
export function identifyVerdict(result: IdentifyResult): IdentifyVerdict {
  if (result.verdict) return result.verdict;
  const out = { thresholds: THRESHOLDS };
  const te = result.te.calls.filter(c => !c.related);
  const qualifying = te.filter(c => confident(c.identity, c.query_coverage));
  if (qualifying.length) {
    const top = qualifying[0];
    const rivals: TeCall[] = [];
    for (const c of qualifying.slice(1)) {
      if (familyKey(c) === familyKey(top) || rivals.some(r => familyKey(r) === familyKey(c))) continue;
      if (c.bitscore >= (1 - AMBIGUOUS_BITSCORE_FRACTION) * top.bitscore && queryOverlap(top, c) >= AMBIGUOUS_MIN_OVERLAP) rivals.push(c);
    }
    if (rivals.length) {
      const names = [top.family, ...rivals.map(c => c.family)];
      return { ...out, status: 'ambiguous', source: 'te', candidates: names,
        reason: `${names.length} TE families score within ${pct0(AMBIGUOUS_BITSCORE_FRACTION)} of each other over the same bases` };
    }
    return { ...out, status: 'candidate', source: 'te', candidates: [top.family],
      reason: `${top.identity.toFixed(1)}% identity over ${pct0(top.query_coverage)} of the insert` };
  }
  const g = result.genome;
  const gene = qualifyingGene(result);
  if (gene) {
    return { ...out, status: 'candidate', source: 'gene', candidates: [gene.gene.gene],
      reason: `exonic match at ${gene.gene.identity.toFixed(1)}% identity over ${pct0(gene.covered)} of the insert` };
  }
  const loci = g.loci.filter(l => confident(l.identity, l.qcov));
  const rm = rmskCandidate(loci);
  if (rm) {
    return { ...out, status: 'candidate', source: 'repeatmasker', candidates: [rm.name],
      reason: `RepeatMasker's name for ${rm.loci.toLocaleString()} genome cop${rm.loci === 1 ? 'y' : 'ies'} that pass the minimums` };
  }
  if (loci.length) {
    const best = loci[0];
    return { ...out, status: 'candidate', source: 'genome', candidates: [`${best.chrom}:${(best.start + 1).toLocaleString()}`],
      reason: `${best.identity.toFixed(1)}% identity over ${pct0(best.qcov)} of the insert` };
  }
  const top = te[0];
  let reason: string;
  if (top) reason = `the closest library family, ${top.family}, has ${top.identity.toFixed(1)}% identity over ${pct0(top.query_coverage)} of the insert`;
  else if (result.te.calls.length) reason = `the closest library family, ${result.te.calls[0].family}, is below ${VERDICT_MIN_IDENTITY}% identity`;
  else if (g.loci.length) reason = `the best genome match has ${g.loci[0].identity.toFixed(1)}% identity over ${pct0(g.loci[0].qcov)} of the insert`;
  else reason = `no match in the genome${result.te.library ? ' or the TE library' : ''}`;
  return { ...out, status: 'no_match', source: null, candidates: [],
    reason: `${reason} (a candidate needs ≥ ${VERDICT_MIN_IDENTITY}% identity over ≥ ${pct0(VERDICT_MIN_QUERY_COVERAGE)} of the insert)` };
}

/** The verdict's heading: "Best candidate", "Ambiguous", "No confident match". */
export function verdictLabel(status: IdentifyVerdict['status']): string {
  return status === 'candidate' ? 'Best candidate' : status === 'ambiguous' ? 'Ambiguous' : 'No confident match';
}

/** What the best candidate was measured with: coverage, identity and the database searched (version included). */
export function candidateEvidence(result: IdentifyResult): string[] {
  const v = identifyVerdict(result);
  const out: string[] = [];
  const lib = result.te.library;
  if (v.source === 'te') {
    for (const name of v.candidates) {
      const c = result.te.calls.find(x => x.family === name && !x.related);
      if (!c) continue;
      out.push(`${c.family}: ${c.identity.toFixed(1)}% identity, ${pct0(c.query_coverage)} of the insert, ${pct0(c.element_coverage)} of the element`);
    }
  } else if (v.source === 'gene') {
    const gene = result.genome.genes.find(x => x.region === 'exon' && x.gene === v.candidates[0]) ?? qualifyingGene(result)?.gene;
    if (gene) out.push(`${gene.gene}: ${gene.identity.toFixed(1)}% identity, ${pct0(spanLength(gene.query) / Math.max(1, result.length))} of the insert`);
  } else if (v.source === 'repeatmasker') {
    const loci = result.genome.loci.filter(l => confident(l.identity, l.qcov) && l.rmsk?.name === v.candidates[0]);
    if (loci[0]) out.push(`${v.candidates[0]} on ${loci.length.toLocaleString()} cop${loci.length === 1 ? 'y' : 'ies'}; best ${locusLabel(loci[0])}: ${loci[0].identity.toFixed(1)}% identity, ${pct0(loci[0].qcov)} of the insert`);
  } else if (v.source === 'genome') {
    const best = result.genome.loci.find(l => confident(l.identity, l.qcov));
    if (best) out.push(`${locusLabel(best)}: ${best.identity.toFixed(1)}% identity, ${pct0(best.qcov)} of the insert`);
  }
  const db: string[] = [];
  if (lib) db.push(`TE library: ${lib.label}${lib.version && !lib.label.includes(lib.version) ? ` ${lib.version}` : ''}`);
  if (result.genome.assembly) db.push(`genome: ${result.genome.assembly}`);
  if (result.genome.rmsk === 'ok') db.push('names: UCSC RepeatMasker (rmsk)');
  if (result.tool?.label) db.push(`search: ${result.tool.label}`);
  else if (result.engine) db.push(`search: ${result.engine}`);
  if (db.length) out.push(db.join(' · '));
  return out;
}

const STRAND_WORD = (s: string | null | undefined) => (s === '-' ? '− strand' : s === '+' ? '+ strand' : '');

/** One-line caption under the cartoon ("full-length roo (LTR/Bel-Pao), − strand, 5-bp TSD"). */
export function caption(result: IdentifyResult, reversed = false): string {
  const flip = (s: string | null | undefined) => (reversed && s ? (s === '+' ? '-' : '+') : s);
  const parts: string[] = [];
  const tes = result.te.calls.filter(c => !c.related);
  if (tes.length) {
    const t = tes[0];
    const shape = t.completeness === 'full length' ? 'full-length' : t.completeness;
    parts.push(`${shape} ${t.family} (${t.class_label}), ${STRAND_WORD(flip(t.strand))}`);
    for (const other of tes.slice(1, 3)) if (other.query_coverage >= 0.1) parts.push(`+ ${other.family} (${other.class_label})`);
  }
  const genes = result.genome.genes.filter(g => g.region === 'exon');
  for (const g of genes.slice(0, 2)) {
    const ex = g.exons.length === 1 ? `exon ${g.exons[0]}` : `exons ${g.exons[0]}–${g.exons[g.exons.length - 1]}`;
    parts.push(`${g.spliced ? 'spliced copy of' : 'fragment of'} ${g.gene} ${ex}`);
  }
  if (!tes.length && !genes.length) parts.push(result.summary);
  if (result.tsd?.confident) parts.push(`${result.tsd.length}-bp TSD`);
  const pa = tes.find(t => t.poly_a);
  if (pa) parts.push('poly(A) tail');
  return parts.join(', ');
}

/** "+" when the lens is mirrored: the strand of the element as drawn. */
export function displayStrand(strand: string | null | undefined, reversed: boolean): string | null {
  if (!strand) return null;
  return reversed ? (strand === '+' ? '-' : '+') : strand;
}

// ---------------------------------------------------------------------------
// Cartoon geometry

export interface CartoonShape {
  kind: Segment['kind'] | 'ltr' | 'orf';
  x0: number; x1: number;
  color: string; label: string;
  /** Pointing right (+) or left (−) as drawn; none for non-oriented parts. */
  arrow: 'right' | 'left' | null;
  /** Jagged edge where the element is truncated (as drawn). */
  jagged: 'left' | 'right' | 'both' | null;
  uncertain: boolean;
  /** Tooltip: what this part is and how sure. */
  title: string;
  /** The TE class key (CLASS_COLORS) when the part is a classified repeat. */
  cls?: string;
}

export interface CartoonModel {
  length: number; reversed: boolean;
  body: CartoonShape[];
  features: CartoonShape[];
  tsd: { seq: string; length: number } | null;
  caption: string;
}

const fmt = (n: number) => n.toLocaleString();

/** The cartoon in display coordinates (0..length, mirrored when the lens is reversed). */
export function cartoonModel(result: IdentifyResult, reversed: boolean): CartoonModel {
  const L = result.length;
  const X = (q: number) => (reversed ? L - q : q);
  const span = (a: number, b: number): [number, number] => {
    const x0 = X(a);
    const x1 = X(b);
    return x0 <= x1 ? [x0, x1] : [x1, x0];
  };
  const tes = result.te.calls.filter(c => !c.related);
  const body: CartoonShape[] = [];
  for (const seg of result.segments) {
    const [x0, x1] = span(seg.qstart, seg.qend);
    const strand = displayStrand(seg.strand, reversed);
    const arrow = seg.kind === 'te' || seg.kind === 'gene' ? (strand === '+' ? 'right' : strand === '-' ? 'left' : null) : null;
    let jagged: CartoonShape['jagged'] = null;
    let uncertain = false;
    let title = `${seg.label}: bases ${fmt(seg.qstart + 1)}–${fmt(seg.qend)}`;
    if (seg.kind === 'te') {
      const call = tes.find(c => c.family === seg.label);
      if (call) {
        title += ` · ${call.class_label} · ${call.identity.toFixed(1)}% identity · element ${fmt(call.element_start + 1)}–${fmt(call.element_end)} of ${fmt(call.element_length)} (${call.completeness})`;
        // Where the element's 5′ end is drawn: the left end of the call when it points right.
        const [cx0, cx1] = span(call.qstart, call.qend);
        const fiveSide: 'left' | 'right' = arrow === 'right' ? 'left' : 'right';
        const threeSide: 'left' | 'right' = fiveSide === 'left' ? 'right' : 'left';
        const atEdge = (side: 'left' | 'right') => (side === 'left' ? Math.abs(x0 - cx0) : Math.abs(x1 - cx1)) <= 25;
        const fiveCut = call.completeness === '5′-truncated' || call.completeness === 'internal fragment';
        const threeCut = call.completeness === '3′-truncated' || call.completeness === 'internal fragment';
        const sides = [fiveCut && atEdge(fiveSide) ? fiveSide : null, threeCut && atEdge(threeSide) ? threeSide : null]
          .filter((v): v is 'left' | 'right' => v !== null);
        jagged = sides.length === 2 ? 'both' : (sides[0] ?? null);
        if (call.identity < 90) { uncertain = true; title += ' · below 90% identity: a diverged or related element'; }
      }
    } else if (seg.kind === 'gene') {
      title += ` · ${seg.identity?.toFixed(1)}% identity${seg.spliced ? ' · introns missing: a spliced copy (retrocopy/cDNA)' : ''}`;
    } else if (seg.kind === 'repeat') {
      title += ` · ${seg.copies ?? '?'} copies in the genome`;
      if (!seg.class) { uncertain = true; title += ' · no family named (download a TE library, or turn on RepeatMasker naming)'; }
    } else if (seg.kind === 'genomic') {
      title += ' · a single-copy match elsewhere in the genome';
    } else if (seg.kind === 'local') {
      title += ' · matches the reference near the insertion site (a local duplication)';
    } else if (seg.kind === 'tsd') {
      title = `Target-site duplication ${result.tsd?.seq ?? ''} (${result.tsd?.length ?? seg.qend - seg.qstart} bp): the reference bases at the site, copied on insertion`;
    } else if (seg.kind === 'polyA') {
      title = `Poly(A) tail: bases ${fmt(seg.qstart + 1)}–${fmt(seg.qend)}`;
    } else {
      uncertain = true;
      title = `No match in the genome${result.te.library ? ' or the TE library' : ''}: bases ${fmt(seg.qstart + 1)}–${fmt(seg.qend)} (novel, or too diverged to align)`;
    }
    const cls = seg.kind === 'te' || (seg.kind === 'repeat' && seg.class) ? classKey(seg.class) : undefined;
    body.push({ kind: seg.kind, x0, x1, color: segmentColor(seg), label: seg.label, arrow, jagged, uncertain, title, cls });
  }
  const features: CartoonShape[] = [];
  for (const call of tes) {
    for (const f of call.mapped_features ?? []) {
      const [x0, x1] = span(f.qstart, f.qend);
      const strand = displayStrand(call.strand, reversed);
      const kind = f.type === 'LTR' ? 'ltr' : f.type === 'ORF' ? 'orf' : null;
      if (!kind) continue;
      features.push({
        kind, x0, x1, color: CLASS_COLORS[classKey(call.class)], label: f.type === 'LTR' ? 'LTR' : f.label,
        arrow: strand === '+' ? 'right' : 'left', jagged: null, uncertain: Boolean(f.partial),
        title: `${call.family} ${f.label}: bases ${fmt(f.qstart + 1)}–${fmt(f.qend)}${f.partial ? ' (partly: the element is truncated here)' : ''}`
          + (f.type === 'ORF' ? ' · from the library\'s annotation of the element' : ''),
      });
    }
  }
  return {
    length: L, reversed, body, features,
    tsd: result.tsd?.confident ? { seq: result.tsd.seq, length: result.tsd.length } : null,
    caption: caption(result, reversed),
  };
}

/** Bins of a lens profile over the insert, in display order, resampled to ``n`` bins. */
export function insertProfile(
  values: (number | null)[], axis: { flank: number; displayLen: number; total: number; reversed: boolean }, n: number,
): (number | null)[] {
  const bins = values.length;
  if (!bins || axis.displayLen <= 0) return [];
  const binWidth = axis.total / bins;
  const start = axis.reversed ? axis.total - axis.flank - axis.displayLen : axis.flank;
  const out: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const a = start + (i / n) * axis.displayLen;
    const b = start + ((i + 1) / n) * axis.displayLen;
    let sum = 0;
    let w = 0;
    for (let k = Math.floor(a / binWidth); k <= Math.min(bins - 1, Math.floor((b - 1e-9) / binWidth)); k++) {
      const v = values[k];
      if (v === null || v === undefined) continue;
      const lo = Math.max(a, k * binWidth);
      const hi = Math.min(b, (k + 1) * binWidth);
      if (hi > lo) { sum += v * (hi - lo); w += hi - lo; }
    }
    out.push(w > 0 ? sum / w : null);
  }
  return out;
}

/** Megabytes for the download button ("0.8 MB"). */
export function formatSize(bytes: number): string {
  return bytes >= 1e5 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

/** Locus label, 1-based ("chr2L:1,234–5,678"). */
export function locusLabel(l: { chrom: string; start: number; end: number }): string {
  return `${l.chrom}:${fmt(l.start + 1)}–${fmt(l.end)}`;
}
