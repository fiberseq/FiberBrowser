"""Assembly differences and read inspection on a graphlift display.

The strip is map evidence, never a variant caller: ``aligned_bubble`` is an
approximate aligned interior and can hide indels. No BAM is opened by
``differences_for_region``. Its bounded LRU caches geometry under
``(lift_key, chrom, 1 Mb bin, hap)``; FASTA bases are attached afterwards so
loading/replacing a reference cannot leave stale alleles in that cache.

GET /api/lift/differences returns::

  {dataset_id, lift_key, chrom, start, end, mode: 'items'|'bins',
   items: [Difference], bin_bp: int|null, bins: [Bin], novel: [Cluster]}

Difference is ``{id, hap, hap_label, kind, reason, source:'assembly',
t_start, t_end, ref_bp, alt_bp, chain:int|null, strand:'+'|'-'|null,
src:{contig,start,end}, grch38:str|null, alt:str|null, t?, ref?, len?,
read_support?:{cluster:int, carriers:int}}``. ``t/ref/len`` are the native
SV schema for insertions/deletions only. Coordinates are absolute, zero
based, half open; insertion target spans have zero width. Source coordinates
are always forward, while allele strings are in target display orientation.
An absent correspondence has null src fields and uses its target coordinates
in the ID (there is no source coordinate to identify). All other IDs are
``<hap_label>:<contig>:<source_start>-<source_end>:<kind>``.

Bin is ``{start,end,hap,hap_label,kind,count,bp,ref_bp,alt_bp}``: an event is
counted once in the bin containing its leftmost visible position; bp totals
are the complete events' sizes, ``bp=sum(max(ref_bp,alt_bp))``. At views wider
than ``detail_bp`` (default 250000), bins replace small individual items;
events >=1000 bp remain in items AND are counted in bins. ``min_bp`` applies
before either aggregation. ``novel`` holds unmatched read-evidence clusters
only when native_dataset_id is supplied; each has ``source:'reads'``.

GET /api/lift/difference_reads returns::

  {dataset_id, lift_key, chrom, pos, end, rows:[Inspection],
   summary:{hap_label:{allele:count}}, preferred_hap:str|null,
   capped:bool, max_records:500}

Inspection is ``{id,molecule,hap_label,record,supplementary,strand,source_pos:
{contig,start,end},read_bases:str,hg002:str|null,grch38:str|null,allele,
chromatin:{state:'nucleosome'|'footprint'|'accessible'|'none',layer:str|null,
nearest_m6a_bp:int|null,orientation:'+'|'-'},ins_id?:str,carries_insertion?:
bool,mol_bp?:int,identity?:float|null,read_bases_length?:int}``. ``strand`` is
the molecule's st (null without it), never the piece strand. At base differences,
hg002 means the read matches its own haplotype's distinct assembly allele;
same_as_grch38 means that haplotype and read both agree with GRCh38. Only a
distinct haplotype carrying GRCh38 is flagged grch38. Other/deleted/no_coverage
retain their ordinary meanings. ``lift_hap``/``item_id`` prioritise one
haplotype's reads without hiding the other haplotype's summary.
Insertion inspection (``pos==end``) resolves map intervals at that boundary.
Carriage (hg002) requires full source-span coverage and molecular length within
max(10%,50 bp); clipped alignments are partial, empty spans deleted, and
flank-spanning non-carriers no_insertion. Identity is a best-effort percent
from the source CIGAR, independent of carriage. Inserted read_bases is at most
60 bases; read_bases_length/mol_bp preserve its full length. Missing target
bases leave base alleles as other. Missing MD and source FASTA leave HG002
unknown. A displayed row's
record key is reused when available, and orientation describes its display.
"""
from __future__ import annotations

import bisect
import re
import threading
from collections import OrderedDict

from services.lift.compose import revcomp

BIN_BP = 1_000_000
_CACHE = OrderedDict()
_CACHE_LOCK = threading.Lock()
_CACHE_MAX = 512


def difference_id(label, contig, start, end, kind):
    return f"{label}:{contig}:{start}-{end}:{kind}"


def insertion_span(handle, contig, a, b, chain):
    """Canonical full map gap for a partial read's badge, else its own span.
    Only source-only gaps are expanded this way: replacement and elsewhere
    badges retain their exact source span rather than claiming a map insertion.
    """
    if handle is not None:
        with handle.lock:
            c = handle.map.chains[chain]
            size = handle.manifest["sources"][c["source"]]["size"]
            for _t, q, dt, dq, _reason in handle.map.chain_data(chain)["gaps"]:
                lo, hi = (q, q + dq) if c["strand"] == "+" else (size - q - dq, size - q)
                if dt == 0 and dq > 0 and lo <= a < b <= hi:
                    return lo, hi
    return a, b


def _source_span(handle, c, q, length):
    if c["strand"] == "+":
        return q, q + length
    size = handle.manifest["sources"][c["source"]]["size"]
    return size - q - length, size - q


def _item(handle, hap, ci, kind, reason, t0, t1, q0, q1):
    c = handle.map.chains[ci] if ci is not None else None
    contig = handle.manifest["sources"][c["source"]]["name"] if c else None
    label = handle.haplotype_labels.get(hap, hap)
    item = dict(id=difference_id(label, contig, q0, q1, kind), hap=hap, hap_label=label, kind=kind,
                reason=reason, source="assembly", t_start=t0, t_end=t1, ref_bp=t1 - t0,
                alt_bp=q1 - q0 if q0 is not None else 0, chain=ci, strand=c["strand"] if c else None,
                src=dict(contig=contig, start=q0, end=q1))
    if kind == "insertion":
        item.update(t="I", ref=t0, len=q1 - q0)
    elif kind == "deletion":
        item.update(t="D", ref=t0, len=t1 - t0)
    return item


def _merge(spans):
    out = []
    for a, b in sorted(spans):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def _bin_items(config, chrom, bin_index, hap):
    handle = config.handle
    key = (config.key(), chrom, bin_index, hap)
    with _CACHE_LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]
    start = bin_index * BIN_BP
    end = min(start + BIN_BP, handle.target_size(chrom) or start + BIN_BP)
    out, coverage = [], []
    with handle.lock:
        ti = handle.map.targets.get(chrom)
        # Nets are the authority for primary status, including a gap whose
        # two flanking blocks might be outside a tiny requested viewport.
        nets = handle.map.nets.get((hap, ti), ())
        for ns, ne, ci in nets:
            c = handle.map.chains[ci]
            ns, ne = max(ns, c["t_start"]), min(ne, c["t_end"])
            data = handle.map.chain_data(ci)
            # Coverage includes full blocks (not bin-clipped), making uncovered
            # stretches and their IDs stable across adjacent bin queries.
            blocks = []
            for t, q, length in data["blocks"]:
                lo, hi = max(ns, t), min(ne, t + length)
                if hi > lo:
                    coverage.append((lo, hi))
                    blocks.append((lo, hi, q + lo - t))
            if ne <= start or ns >= end:
                continue
            if c["strand"] == "-" and blocks:
                qs = [_source_span(handle, c, q, hi - lo) for lo, hi, q in blocks]
                out.append(_item(handle, hap, ci, "inversion", "inversion", ns, ne,
                                 min(q[0] for q in qs), max(q[1] for q in qs)))
            for t, length, kind in handle.map.inferred_runs(ci, ns, ne):
                if kind not in ("substitution", "aligned"):
                    continue
                for lo, hi, q in blocks:
                    a, b = max(t, lo), min(t + length, hi)
                    if b <= a or b <= start or a >= end:
                        continue
                    q0, q1 = _source_span(handle, c, q + a - lo, b - a)
                    k = "aligned_bubble" if kind == "aligned" else ("snv" if b - a == 1 else "mnv")
                    out.append(_item(handle, hap, ci, k, kind, a, b, q0, q1))
            for t, q, dt, dq, reason in data["gaps"]:
                if not (ns <= t < ne) or not (start <= t < end or (dt and t < end and t + dt > start)):
                    continue
                if dt < 0 or dq < 0 or not (dt or dq):
                    continue
                kind = "replacement" if dt and dq else ("insertion" if dq else "deletion")
                q0, q1 = _source_span(handle, c, q, dq)
                out.append(_item(handle, hap, ci, kind, handle.map.reasons[reason], t, t + dt, q0, q1))
        pos = 0
        for a, b in _merge(coverage) + [[handle.target_size(chrom) or end, handle.target_size(chrom) or end]]:
            if a > pos and a > start and pos < end:
                item = _item(handle, hap, None, "no_correspondence", "no_correspondence", pos, a, None, None)
                item["id"] = difference_id(handle.haplotype_labels.get(hap, hap), chrom, pos, a, "no_correspondence")
                out.append(item)
            pos = max(pos, b)
    with _CACHE_LOCK:
        _CACHE[key] = out
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return out


def fasta_bases(fasta, chrom, start, end):
    """Same chromosome alias resolution as SequenceTrack's /api/sequence.
    No FASTA means unknown, never an invented N allele.
    """
    if fasta is None or chrom is None:
        return None
    from utils.chrom import resolve_reference_name
    ref = resolve_reference_name(chrom, fasta.references)
    if ref is None:
        return None
    try:
        return fasta.fetch(ref, max(0, int(start)), max(0, int(end))).upper()
    except (ValueError, KeyError):
        return None


def _haps(config, lift_hap):
    if not lift_hap:
        return config.haplotypes
    return [h for h in config.handle.resolve_haplotypes([lift_hap]) if h in config.haplotypes]


def assembly_items_for_region(config, chrom, start, end, *, lift_hap=None, min_bp=0):
    """Fresh copies of cached geometry, including events hidden by binning.
    Read evidence must match these too, otherwise a known small assembly
    insertion would incorrectly become novel when the user zooms out.
    """
    items = {}
    for hap in _haps(config, lift_hap):
        for b in range(start // BIN_BP, (max(start + 1, end) - 1) // BIN_BP + 1):
            for item in _bin_items(config, chrom, b, hap):
                a, z = item["t_start"], item["t_end"]
                if (a == z and start <= a < end or a < end and z > start) and max(item["ref_bp"], item["alt_bp"]) >= min_bp:
                    items[item["id"]] = dict(item)
    return sorted(items.values(), key=lambda d: (d["t_start"], d["hap_label"], d["kind"]))


def differences_for_region(state, dataset, chrom, start, end, *, lift_hap=None, min_bp=0, detail_bp=250_000):
    """The difference-strip JSON documented above. Geometry cache never does BAM I/O."""
    import pysam
    config = dataset.live_lift
    items = assembly_items_for_region(config, chrom, start, end, lift_hap=lift_hap, min_bp=min_bp)
    broad = end - start > detail_bp
    bin_bp, bins = None, []
    if broad:
        bin_bp = max(1000, 10 ** max(3, len(str(max(1, (end - start) // 100))) - 1))
        grouped = {}
        for item in items:
            b = max(start, item["t_start"]) // bin_bp * bin_bp
            key = b, item["hap"], item["kind"]
            v = grouped.setdefault(key, dict(start=b, end=b + bin_bp, hap=item["hap"], hap_label=item["hap_label"],
                                             kind=item["kind"], count=0, bp=0, ref_bp=0, alt_bp=0))
            v["count"] += 1
            v["bp"] += max(item["ref_bp"], item["alt_bp"])
            v["ref_bp"] += item["ref_bp"]
            v["alt_bp"] += item["alt_bp"]
        bins = [grouped[k] for k in sorted(grouped)]
        items = [v for v in items if max(v["ref_bp"], v["alt_bp"]) >= 1000]
    source = pysam.FastaFile(config.source_fasta) if config.source_fasta else None
    try:
        for item in items:
            item["grch38"] = ("" if item["kind"] == "insertion" else
                              fasta_bases(getattr(state, "fasta", None), chrom, item["t_start"], item["t_end"])
                              if item["kind"] in ("snv", "mnv", "deletion") and item["ref_bp"] <= 50 else None)
            src = item["src"]
            item["alt"] = fasta_bases(source, src["contig"], src["start"], src["end"])
            if item["alt"] is not None and item["strand"] == "-":
                item["alt"] = revcomp(item["alt"])
    finally:
        if source is not None:
            source.close()
    return dict(dataset_id=dataset.id, lift_key=config.key(), chrom=chrom, start=start, end=end,
                mode="bins" if broad else "items", items=items, bin_bp=bin_bp, bins=bins, novel=[])


def annotate_read_evidence(items, sv_clusters):
    """Annotate assembly items in place; return unmatched read-only clusters.
    Accepts cluster_sv_events' clusters (members set) or the display summary's
    clusters (support count). A cluster can support both haplotypes. Extra
    provenance keys never enter events_match's breakpoint/length comparison.
    """
    from services.sv_events import events_match
    matched = set()
    for item in items:
        if item.get("t") not in ("I", "D"):
            continue
        for i, c in enumerate(sv_clusters):
            if c.get("source", "reads") != "reads" or c.get("t") != item["t"]:
                continue
            if events_match(item["t"], item["ref"], item["len"], c["ref"], c["len"]):
                item["read_support"] = {"cluster": i, "carriers": c.get("support", len(c.get("members", ())))}
                matched.add(i)
                break
    return [{**{k: v for k, v in c.items() if k != "members"}, "source": "reads"}
            for i, c in enumerate(sv_clusters) if i not in matched and c.get("source", "reads") == "reads"]


def md_reference(md, runs):
    """Sparse source-reference mismatches from MD over aligned runs.
    MD consumes deletions but not CIGAR insertions/skips. Runs carry absolute
    source positions, so walking only the aligned-base MD index avoids
    accidentally shifting every mismatch after a read deletion or N skip.
    """
    if md is None:
        return {}
    starts, ends, total = [], [], 0
    for r0, _m0, n in runs:
        starts.append((total, r0))
        total += n
        ends.append(total)
    out, index = {}, 0
    for token in re.findall(r"\d+|\^[A-Za-z]+|[A-Za-z]", md):
        if token.isdigit():
            index += int(token)
        elif token.startswith("^"):
            continue
        else:
            i = bisect.bisect_right(ends, index)
            if i < len(starts):
                offset, ref = starts[i]
                out[ref + index - offset] = token.upper()
            index += 1
    return out


def row_mismatches(read, row, ctx):
    """View-only X markers with native renderer aliases ``len=1, seq=base``.
    SEQ indices in _SeqRuns include hard clips; subtract the leading clip
    before indexing the stored SEQ. Ref/alt are complemented on '-' pieces.
    HG002 reference differences come from MD (or the optional source FASTA),
    never from assuming every observed base is an assembly allele.
    """
    from services.lift.compose import _SeqRuns
    seq = read.get("_fiberbrowser_sequence") or ""
    if not seq:
        return []
    record = read.get("_fiberbrowser_lift_record") or {}
    runs = _SeqRuns(read.get("_fiberbrowser_aligned_runs"), record)
    md = md_reference(read.get("_fiberbrowser_md"), read.get("_fiberbrowser_aligned_runs") or [])
    lead = int(read.get("_fiberbrowser_sequence_lead", 0))
    out = []
    target = ctx.loader_options["target_fasta"]
    detail_start, detail_end = ctx.loader_options.get("detail_view", (ctx.region_start, ctx.region_end))
    for f in row.frags:
        a, b = max(ctx.region_start, f.t0, detail_start), min(ctx.region_end, f.t1, detail_end)
        if b <= a:
            continue
        ref = fasta_bases(target, ctx.selection.chrom, a, b)
        if ref is None:
            continue
        with ctx.handle.lock:
            inferred = ctx.handle.map.inferred_runs(f.p.chain, a, b)
        qlo = f.p.q_start + (f.p.t_end - b if f.minus else a - f.p.t_start)
        qhi = qlo + b - a
        source_ref = fasta_bases(getattr(ctx, "source_fasta", None), record.get("contig"), qlo, qhi)
        for r0, q0, n in zip(runs.ref, runs.seq, runs.len):
            lo, hi = max(r0, f.s, qlo), min(r0 + n, f.e, qhi)
            for x in range(lo, hi):
                t = f.T(x)
                if not a <= t < b:
                    continue
                qi = q0 + x - r0 - lead
                if not 0 <= qi < len(seq):
                    continue
                base = seq[qi].upper()
                hg = (source_ref[x - qlo] if source_ref is not None else
                      md.get(x, base) if read.get("_fiberbrowser_md") is not None else None)
                if f.minus:
                    base, hg = revcomp(base), revcomp(hg) if hg is not None else None
                rb = ref[t - a]
                kinds = [k for s, ln, k in inferred if s <= t < s + ln]
                mapped = any(k in ("substitution", "aligned") for k in kinds)
                is_ref = "substitution" in kinds and hg is not None and hg != rb and base == rb
                if base != rb or is_ref:
                    ev = dict(type="X", pos=t - ctx.region_start, base=base, ref=rb,
                              source="assembly" if mapped and hg == base else "reads", len=1, seq=base)
                    if is_ref:
                        ev["allele"] = "grch38"
                    out.append(ev)
    return out


def _inspection_spans(config, chrom, pos, end, lift_hap):
    """Resolve insertion boundaries explicitly; ordinary point projection has
    no way to recover source bases that have no target correspondence."""
    handle = config.handle
    haps = _haps(config, lift_hap)
    spans = []
    if pos == end:
        for hap in haps:
            for item in _bin_items(config, chrom, pos // BIN_BP, hap):
                if item["kind"] == "insertion" and item["t_start"] == pos:
                    spans.append(item)
        # A haplotype without an insertion still has informative reads across
        # this boundary. Project its adjacent base, then inspect the zero-width
        # source boundary instead of borrowing the other parent's inserted bases.
        present = {s["hap"] for s in spans}
        for span in _inspection_spans(config, chrom, pos, pos + 1, lift_hap):
            if span["hap"] in present or span["src"]["start"] is None:
                continue
            q = span["src"]["end"] if span["strand"] == "-" else span["src"]["start"]
            span["src"] = dict(span["src"], start=q, end=q)
            spans.append(span)
    else:
        with handle.lock:
            pieces = handle.map.target_to_source(chrom, pos, end)
        grouped = {}
        for p in pieces:
            c = handle.map.chains[p.chain]
            hap = c["haplotype"]
            if not p.primary or hap not in haps:
                continue
            if p.chain in grouped:
                v = grouped[p.chain]
                v["src"]["start"] = min(v["src"]["start"], p.q_start)
                v["src"]["end"] = max(v["src"]["end"], p.q_end)
            else:
                grouped[p.chain] = _item(handle, hap, p.chain, "inspection", "inspection", pos, end, p.q_start, p.q_end)
        spans = list(grouped.values())
        # A target-only gap has no primary aligned piece, but its adjacent
        # source records can still be inspected as deleted against GRCh38.
        if not spans:
            for hap in haps:
                for item in _bin_items(config, chrom, pos // BIN_BP, hap):
                    if item["kind"] == "deletion" and item["t_start"] <= pos and item["t_end"] >= end:
                        spans.append(item)
    return spans


def _record_alleles(record, a, b, source_fasta):
    """Read SEQ and source-reference bases of one forward source interval.
    The CIGAR is walked once; get_aligned_pairs is used only with MD and only
    on the bounded inspection cohort, including reference bases in deletions.
    """
    seq = record.query_sequence or ""
    r, q = record.reference_start, 0
    bases, covered, deleted, inserted, aligned = [], 0, 0, 0, []
    for op, n in record.cigartuples or ():
        if op in (0, 7, 8):
            lo, hi = max(a, r), min(b, r + n)
            if hi > lo:
                bases.append(seq[q + lo - r:q + hi - r])
                aligned.append((lo, hi, q + lo - r))
                covered += hi - lo
            r, q = r + n, q + n
        elif op == 1:
            # Same boundary convention as _SeqRuns.mol_between: an I before
            # base b lies between the first aligned bases at a and b.
            if a < r <= b:
                bases.append(seq[q:q + n])
                inserted += n
            q += n
        elif op in (2, 3):
            if op == 2:
                deleted += max(0, min(b, r + n) - max(a, r))
            r += n
        elif op == 4:
            q += n
    ref = fasta_bases(source_fasta, record.reference_name, a, b)
    if ref is None and record.has_tag("MD"):
        # pysam reconstructs reference bases from SEQ/MD; lower-case letters
        # are mismatches, normalised here before allele comparison.
        refs = {rp: rb.upper() for _qp, rp, rb in record.get_aligned_pairs(with_seq=True)
                if rp is not None and rb is not None and a <= rp < b}
        ref = "".join(refs[x] for x in range(a, b)) if all(x in refs for x in range(a, b)) else None
    read_bases = "".join(bases).upper()
    overlaps = covered + deleted > 0 if b > a else record.reference_start <= a <= record.reference_end
    # The BAM alignment already supplies correspondence, including internal
    # indels; string equality would call nearly every noisy long carrier other.
    denominator = covered + deleted + inserted
    identity = (round(100 * sum(sum(x == y for x, y in zip(seq[qi:qi + hi - lo].upper(), ref[lo - a:hi - a]))
                                for lo, hi, qi in aligned) / denominator, 2)
                if ref is not None and seq and denominator else None)
    return read_bases, ref, covered, overlaps, identity


def _chromatin(row, origin, pos, orientation):
    x = pos - origin
    state, layer_name = "none", None
    for name, layer in (row.get("layers") or {}).items():
        if not isinstance(layer, dict):
            continue
        if any(iv[0] <= x < iv[1] for iv in layer.get("intervals") or ()):
            if name in ("nuc", "footprint", "msp", "fire", "tf"):
                state = "nucleosome" if name == "nuc" else ("accessible" if name in ("msp", "fire") else "footprint")
                layer_name = name
                break
    if state == "none":
        for a, b, size, *_ in row.get("intervals") or ():
            if a <= x < b:
                state = "nucleosome" if size >= 90 else ("footprint" if size > 0 else "accessible" if size < 0 else "none")
                break
    distance = min((abs(p - x) for p in row.get("methyl_m6a") or ()), default=51)
    return dict(state=state, layer=layer_name, nearest_m6a_bp=distance if distance <= 50 else None,
                orientation=orientation)


def difference_reads(state, dataset, chrom, pos, end, *, lift_hap=None, item_id=None):
    """Bounded source-record inspection; see the module docstring for JSON.
    An in-memory BAM adapter lets the ordinary display composer decode the
    same <=500 fetched records when a broad cache is absent. No second BAM
    fetch or primary-record lookup can escape the inspection record budget.
    """
    import hashlib
    import time
    from contextlib import ExitStack
    import pysam
    from services.lift.reads import lifted_reads_for_region, filter_lift_display
    from services.read_auxiliary_endpoint import _cached_lift_rows

    config = dataset.live_lift
    spans = _inspection_spans(config, chrom, pos, end, None)
    selected = next((d for d in assembly_items_for_region(config, chrom, pos, max(pos + 1, end))
                     if d["id"] == item_id), None) if item_id else None
    preferred = selected["hap"] if selected else (next(iter(_haps(config, lift_hap)), None) if lift_hap else None)
    preferred_label = config.handle.haplotype_labels.get(preferred, preferred)
    spans.sort(key=lambda s: s["hap"] != preferred)
    if any(s["src"]["end"] - s["src"]["start"] > 50_000 for s in spans):
        from services.lift.live_lift import LiftRefused
        raise LiftRefused("Live lift: this insertion exceeds the 50 kb inspection limit")
    rows, capped = [], False
    view_start, view_end = max(0, pos - 50), min(config.handle.target_size(chrom), max(pos + 1, end) + 50)
    display, broad_key = _cached_lift_rows(state, dataset, chrom, view_start, view_end, time.time())
    origin = broad_key[2] if broad_key else view_start

    class _Records:
        def __init__(self, bam, records):
            self.bam, self.records = bam, records

        def __getattr__(self, name):
            return getattr(self.bam, name)

        def fetch(self, contig, start, end, **kwargs):
            return (r for r in self.records if r.reference_name == contig and r.reference_start < end and r.reference_end > start)

    with ExitStack() as stack:
        source = stack.enter_context(pysam.FastaFile(config.source_fasta)) if config.source_fasta else None
        fetched, adapters = [], {}
        for path in dataset.paths:
            bam = stack.enter_context(pysam.AlignmentFile(path, "rb"))
            records, seen, occurrences = [], set(), {}
            for span in spans:
                src = span["src"]
                if src["contig"] not in bam.references:
                    continue
                a, b = src["start"], src["end"]
                for record in bam.fetch(src["contig"], max(0, a - (a == b)), max(a + 1, b)):
                    if record.is_unmapped or record.is_secondary:
                        continue
                    # A record may be returned by multiple source windows. The
                    # virtual offset distinguishes identical duplicate records.
                    identity = bam.tell()
                    if identity in seen:
                        continue
                    if len(fetched) >= 500:
                        capped = True
                        break
                    seen.add(identity)
                    sha = hashlib.sha256(record.to_string().encode()).hexdigest()
                    occurrence = occurrences.get(sha, 0)
                    occurrences[sha] = occurrence + 1
                    records.append(record)
                    fetched.append((path, record, f"{sha}:{occurrence}"))
                if capped:
                    break
            adapters[path] = _Records(bam, records)
            if capped:
                break
        if display is None and fetched:
            # Missing paths after the cap are empty adapters, never real BAM
            # handles, so the display fallback stays inside this exact cohort.
            empty = _Records(next(iter(adapters.values())).bam, [])
            display = lifted_reads_for_region(dataset, chrom, view_start, view_end,
                                               dict(include_layers=True, include_methylation=True),
                                               bam_handle_getter=lambda p: adapters.get(p, empty))
        display = filter_lift_display(display or [], dataset, None)
        by_record = {}
        for row in display:
            ll = row.get("live_lift") or {}
            by_record.setdefault((row.get("source_path"), ll.get("record")), []).append(row)
        ref = fasta_bases(getattr(state, "fasta", None), chrom, pos, end)
        for path, record, record_id in fetched:
            candidates = by_record.get((path, record_id), [])
            for span in spans:
                src = span["src"]
                a, b = src["start"], src["end"]
                if record.reference_name != src["contig"] or not (record.reference_start < max(a + 1, b) and record.reference_end > a):
                    continue
                row = next((r for r in candidates if any(s[3] == span["strand"] for s in r["live_lift"]["segments"])), {})
                ll = row.get("live_lift") or {}
                if ll and ll.get("alt"):
                    continue
                if record.is_supplementary and config.settings.supplementary_display == "hide":
                    continue
                rb, hg, n_aligned, overlaps, identity = _record_alleles(record, a, b, source)
                if span["strand"] == "-":
                    rb, hg = revcomp(rb), revcomp(hg) if hg is not None else None
                allele = ("no_coverage" if not overlaps else "deleted" if not rb else
                          "hg002" if hg is not None and ref is not None and rb == hg and hg != ref else
                          "same_as_grch38" if hg is not None and ref is not None and rb == hg == ref else
                          "grch38" if hg is not None and ref is not None and hg != ref and rb == ref else "other")
                carries = False
                if pos == end:
                    full = record.reference_start <= a and record.reference_end >= b
                    length = b - a
                    carries = full and length > 0 and bool(rb) and abs(len(rb) - length) <= max(length * .1, 50)
                    allele = ("no_coverage" if not overlaps else "no_insertion" if length == 0 else
                              "partial" if not full else "deleted" if not rb else
                              "hg002" if carries else "no_insertion")
                st = row.get("strand") or (record.get_tag("st") if record.has_tag("st") else None)
                item = dict(id=record.query_name, molecule=ll.get("molecule", f"{dataset.id}|{record.query_name}"),
                            hap_label=ll.get("hap_label", span["hap_label"]), record=ll.get("record", record_id),
                            supplementary=bool(record.is_supplementary), strand=st, source_pos=dict(src),
                            read_bases=rb, hg002=hg, grch38=ref, allele=allele,
                            chromatin=_chromatin(row, origin, pos, span["strand"]))
                if pos == end:
                    item.update(carries_insertion=carries, mol_bp=len(rb), identity=identity,
                                read_bases=rb[:60], read_bases_length=len(rb))
                    if span["kind"] == "insertion":
                        item["ins_id"] = span["id"]
                    # At an insertion boundary inspect the hidden block's state
                    # at the first covered base, rather than an unrelated call
                    # on the target flank. This also exposes the row's flip.
                    block = (ll.get("insertions") or {}).get(span["id"])
                    if block and not block.get("too_large"):
                        item["chromatin"] = _chromatin(block, 0, block["covered"][0], span["strand"])
                rows.append(item)
    rows.sort(key=lambda r: r["hap_label"] != preferred_label)
    summary = {}
    for row in rows:
        counts = summary.setdefault(row["hap_label"], {})
        counts[row["allele"]] = counts.get(row["allele"], 0) + 1
    return dict(dataset_id=dataset.id, lift_key=config.key(), chrom=chrom, pos=pos, end=end, rows=rows,
                summary=summary, preferred_hap=preferred_label, capped=capped, max_records=500)
