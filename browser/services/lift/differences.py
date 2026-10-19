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
read_support?:{cluster:int, carriers:int}, read_candidates?:[Candidate]}``.
Candidate links retain both spans and uncertainty with relation=candidate,
method=geometry_only and sequence_comparison=unassessed. The legacy support
pointer names the first candidate; counts are never unioned. ``t/ref/len`` are the native
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
before either aggregation. The legacy ``novel`` field holds unmatched read
events only when native_dataset_id is supplied; each has ``source:'reads'``,
``novelty:'unassessed'`` and reasons, never a claim of assembly-relative novelty.

GET /api/lift/difference_reads returns::

  {dataset_id, lift_key, chrom, pos, end, rows:[Inspection],
   summary:{hap_label:{allele:count}}, preferred_hap:str|null,
   capped:bool, max_records:500, hap_status:{hap_label:status},
   sequence:null|{sequence,read_id,record,ins_id,orientation,source:'reads'}}

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
Observed carriage requires full source-span coverage and molecular length within
max(10%,50 bp); clipped alignments are partial, empty spans deleted, and
flank-spanning non-carriers no_insertion. Cross-parent carriage is kept separate
from the molecule's own-parent allele and cannot supply the selected parent's
Identify sequence. Read-only CIGAR insertions resolve zero-width source sites.
Identity is a best-effort percent
from the source CIGAR, independent of carriage. Inserted read_bases is at most
60 bases; read_bases_length/mol_bp preserve its full length. include_sequence
returns one full oriented carrier for item_id on demand (at most 50 kb). Missing target
bases leave base alleles unknown; a length-distinct assembly match can still
be identified geometrically. Missing MD and source FASTA leave HG002
unknown (allele=unknown). Cross-parent rows keep alignment_hg002 separately. A displayed row's
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


def item_has_id(item, item_id):
    return item["id"] == item_id or item_id in item.get("aliases", ())


def source_only_gap(handle, contig, a, b, chain):
    """Canonical owned alternate span containing this badge, or None.
    The historical helper name also covers replacements with source bases.
    Indexed source coordinates work on both strands; an unmatched source
    span never establishes an assembly insertion.
    """
    if handle is not None:
        with handle.lock:
            c = handle.map.chains[chain]
            size = handle.manifest["sources"][c["source"]]["size"]
            if handle.manifest["sources"][c["source"]]["name"] != contig:
                return None
            q0, q1 = (a, b) if c["strand"] == "+" else (size - b, size - a)
            data = handle.map.chain_data(chain)
            i = bisect.bisect_right(data["gq"], q0) - 1
            if i >= 0:
                t, q, dt, dq, _reason = data["gaps"][i]
                if dq > 0 and q <= q0 < q1 <= q + dq:
                    chrom = handle.manifest["targets"][c["target"]]["name"]
                    if any(ci == chain and g == data["gaps"][i] for ci, g, _ in
                           primary_gaps_for_region(handle, chrom, c["haplotype"], t, t + max(dt, 1))):
                        return _source_span(handle, c, q, dq)
    return None


def insertion_span(handle, contig, a, b, chain):
    return source_only_gap(handle, contig, a, b, chain) or (a, b)


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


def primary_gap_records(handle, chrom, hap):
    """Raw gaps owned by a winning net interior or its two exact flanks.

    Caller holds handle.lock. Losing chains never establish correspondence.
    In particular a hole is not a deletion unless the *same* winning chain
    has that precise raw gap, with no intervening or overlapping net claim.
    Return (chain, raw gap, recovered_boundary) once per gap.
    """
    cache = getattr(handle, "_primary_gap_cache", None)
    if cache is None:
        # The registry replaces the handle when its fingerprint changes.
        handle._primary_gap_cache = cache = {}
    key = (chrom, hap)
    if key in cache:
        return cache[key][0]
    ti = handle.map.targets.get(chrom)
    nets = sorted(set((max(ns, handle.map.chains[ci]["t_start"]),
                       min(ne, handle.map.chains[ci]["t_end"]), ci)
                      for ns, ne, ci in handle.map.nets.get((hap, ti), ())
                      if ns < ne))
    nets = [n for n in nets if n[0] < n[1]]
    starts = [n[0] for n in nets]
    # A malformed/ambiguous overlap must not award either chain ownership.
    overlaps, furthest_end = [], -1
    for ns, ne, _ci in nets:
        if ns < furthest_end:
            overlaps.append((ns, min(ne, furthest_end)))
        furthest_end = max(furthest_end, ne)
    conflicts = _merge(overlaps)
    out, unresolved = [], []
    for ci in sorted({n[2] for n in nets}):
        own = [(a, b) for a, b, chain in nets if chain == ci]
        for gap in handle.map.chain_data(ci)["gaps"]:
            t, _q, dt, dq, _reason = gap
            if dt < 0 or dq < 0 or not (dt or dq):
                continue
            i = bisect.bisect_right(starts, t) - 1
            interior = (i >= 0 and nets[i][2] == ci and nets[i][0] < t
                        and t + dt < nets[i][1])
            j = bisect.bisect_left(starts, t) - 1
            boundary = (j >= 0 and j + 1 < len(nets) and nets[j][1] == t
                        and nets[j + 1][0] == t + dt and nets[j][2] == nets[j + 1][2] == ci)
            lo, hi = t - 1, t + dt + 1  # ownership includes both aligned flanks
            conflicted = any(a < hi and b > lo for a, b in conflicts)
            if not (interior or boundary) or conflicted:
                # Keep the exact raw gap when both prospective flanks belong
                # to this chain but intervening/overlapping claims veto it.
                # It is inspectable uncertainty, never a smaller inferred SV.
                if any(a < t <= b for a, b in own) and any(a <= t + dt < b for a, b in own):
                    claims = [{'start': a, 'end': b, 'chain': chain} for a, b, chain in nets
                              if chain != ci and a < hi and b > lo]
                    if claims or conflicted:
                        unresolved.append((ci, gap, claims))
                continue
            out.append((ci, gap, boundary and not interior))
    out.sort(key=lambda record: record[1][0])
    starts, ends, furthest = [], [], -1
    for _ci, (t, _q, dt, _dq, _reason), _boundary in out:
        starts.append(t)
        furthest = max(furthest, t + max(dt, 1))
        ends.append(furthest)
    coverage = _merge([(ns, ne) for ns, ne, _ci in nets] +
                      [(g[0], g[0] + g[2]) for _ci, g, _boundary in out if g[2]])
    cache[key] = (out, starts, ends, coverage, unresolved)
    return out


def primary_gaps_for_region(handle, chrom, hap, start, end):
    """Indexed owned gaps overlapping a half-open target view; caller holds lock."""
    records = primary_gap_records(handle, chrom, hap)
    _, starts, ends, _, _unresolved = handle._primary_gap_cache[(chrom, hap)]
    lo, hi = bisect.bisect_right(ends, start), bisect.bisect_left(starts, end)
    return [r for r in records[lo:hi] if r[1][0] + max(r[1][2], 1) > start]


def _bin_items(config, chrom, bin_index, hap):
    handle = config.handle
    key = (config.key(), chrom, bin_index, hap)
    with _CACHE_LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]
    start = bin_index * BIN_BP
    end = min(start + BIN_BP, handle.target_size(chrom) or start + BIN_BP)
    out = []
    with handle.lock:
        gaps = primary_gaps_for_region(handle, chrom, hap, start, end)
        coverage = handle._primary_gap_cache[(chrom, hap)][3]
        for ci, (t, q, dt, dq, reason), claims in handle._primary_gap_cache[(chrom, hap)][4]:
            if t >= end or t + max(dt, 1) <= start:
                continue
            q0, q1 = _source_span(handle, handle.map.chains[ci], q, dq)
            item = _item(handle, hap, ci, 'no_correspondence', 'conflicting_map_ownership', t, t + dt, q0, q1)
            item.update(ownership_status='unresolved', sequence_status='unresolved', competing_claims=claims,
                        raw_gap=dict(chain=ci, t=t, q=q, dt=dt, dq=dq, reason=handle.map.reasons[reason]))
            out.append(item)
        ti = handle.map.targets.get(chrom)
        # Nets are the authority for primary status, including a gap whose
        # two flanking blocks might be outside a tiny requested viewport.
        nets = handle.map.nets.get((hap, ti), ())
        for ns, ne, ci in nets:
            c = handle.map.chains[ci]
            ns, ne = max(ns, c["t_start"]), min(ne, c["t_end"])
            if ne <= start or ns >= end:
                continue
            data = handle.map.chain_data(ci)
            # Coverage includes full blocks (not bin-clipped), making uncovered
            # stretches and their IDs stable across adjacent bin queries.
            blocks = []
            lo_index = bisect.bisect_right(data["bt"], max(ns, start))
            hi_index = bisect.bisect_left(data["bt"], min(ne, end)) + 1
            for t, q, length in data["blocks"][lo_index:hi_index]:
                lo, hi = max(ns, t), min(ne, t + length)
                if hi > lo:
                    blocks.append((lo, hi, q + lo - t))
            if c["strand"] == "-" and blocks:
                # Preserve the full inversion ID independently of bin clipping.
                full = [(max(ns, t), min(ne, t + n), q + max(ns, t) - t)
                        for t, q, n in data["blocks"] if t < ne and t + n > ns]
                qs = [_source_span(handle, c, q, hi - lo) for lo, hi, q in full]
                out.append(_item(handle, hap, ci, "inversion", "inversion", ns, ne,
                                 min(q[0] for q in qs), max(q[1] for q in qs)))
            for t, length, kind in handle.map.inferred_runs(ci, max(ns, start), min(ne, end)):
                if kind not in ("substitution", "aligned"):
                    continue
                for lo, hi, q in blocks:
                    a, b = max(t, lo), min(t + length, hi)
                    if b <= a or b <= start or a >= end:
                        continue
                    q0, q1 = _source_span(handle, c, q + a - lo, b - a)
                    k = "aligned_bubble" if kind == "aligned" else ("snv" if b - a == 1 else "mnv")
                    out.append(_item(handle, hap, ci, k, kind, a, b, q0, q1))
        for ci, (t, q, dt, dq, reason), recovered in gaps:
            c = handle.map.chains[ci]
            kind = "replacement" if dt and dq else ("insertion" if dq else "deletion")
            q0, q1 = _source_span(handle, c, q, dq)
            item = _item(handle, hap, ci, kind, handle.map.reasons[reason], t, t + dt, q0, q1)
            item["sequence_status"] = "unresolved"
            if recovered:
                item["aliases"] = [difference_id(item["hap_label"], chrom, t, t + dt, "no_correspondence")]
            out.append(item)
        pos = 0
        # Unknown chromosome size has no authoritative trailing endpoint.
        # Emit bounded holes between nets, never a bin-dependent artificial tail.
        size = handle.target_size(chrom)
        sentinel = [[size, size]] if size is not None else []
        for a, b in coverage + sentinel:
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
            item["ref_truncated"] = item["ref_bp"] > 60
            item["grch38"] = ("" if item["kind"] == "insertion" else
                              fasta_bases(getattr(state, "fasta", None), chrom, item["t_start"], min(item["t_end"], item["t_start"] + 60))
                              if item["kind"] in ("snv", "mnv", "deletion", "replacement") else None)
            src = item["src"]
            a, b = src["start"], src["end"]
            item["alt_truncated"] = a is not None and b - a > 60
            if a is not None:
                a, b = (max(a, b - 60), b) if item["strand"] == "-" else (a, min(b, a + 60))
            item["alt"] = "" if item["kind"] == "deletion" else fasta_bases(source, src["contig"], a, b)
            if item["alt"] is not None and item["strand"] == "-":
                item["alt"] = revcomp(item["alt"])
            item["alt_sequence_status"] = ("unavailable" if item["alt"] is None else
                                           "partial" if item["alt_truncated"] else "available")
            item["ref_sequence_status"] = ("unavailable" if item["grch38"] is None else
                                           "partial" if item["ref_truncated"] else "available")
            statuses = (item["ref_sequence_status"], item["alt_sequence_status"])
            item["sequence_status"] = ("available" if statuses == ("available", "available") else
                                       "unavailable" if statuses == ("unavailable", "unavailable") else "partial")
    finally:
        if source is not None:
            source.close()
    return dict(dataset_id=dataset.id, lift_key=config.key(), chrom=chrom, start=start, end=end,
                mode="bins" if broad else "items", items=items, bin_bp=bin_bp, bins=bins, novel=[])


def difference_sequence(dataset, chrom, pos, item_id, *, offset=0, limit=50_000, allele="alternate", reference=None):
    """On-demand reference or alternate sequence in bounded target-oriented pages."""
    import pysam
    from fastapi import HTTPException
    item = next((d for d in assembly_items_for_region(dataset.live_lift, chrom, pos, pos + 1)
                 if item_has_id(d, item_id)), None)
    if item is None:
        raise HTTPException(404, "Assembly difference not found at this position")
    if allele not in ("reference", "alternate"):
        raise HTTPException(422, "allele must be reference or alternate")
    if allele == "reference":
        total = item["ref_bp"]
        if offset > total:
            raise HTTPException(422, "Sequence offset exceeds allele length")
        stop = min(total, offset + limit)
        sequence = "" if total == 0 else fasta_bases(reference, chrom, item["t_start"] + offset, item["t_start"] + stop)
        if sequence is None:
            raise HTTPException(409, "Target reference sequence unavailable")
        return dict(item_id=item["id"], sequence=sequence, offset=offset, total=total,
                    next_offset=stop if stop < total else None, source="reference", allele=allele, orientation="+")
    src = item["src"]
    if src["start"] is None or (not dataset.live_lift.source_fasta and item["alt_bp"]):
        raise HTTPException(409, "Source assembly sequence unavailable")
    total = src["end"] - src["start"]
    if offset > total:
        raise HTTPException(422, "Sequence offset exceeds allele length")
    stop = min(total, offset + limit)
    a, b = ((src["end"] - stop, src["end"] - offset) if item["strand"] == "-"
            else (src["start"] + offset, src["start"] + stop))
    if total == 0:
        sequence = ""
    else:
        with pysam.FastaFile(dataset.live_lift.source_fasta) as source:
            sequence = fasta_bases(source, src["contig"], a, b)
    if sequence is None:
        raise HTTPException(409, "Source assembly sequence unavailable")
    if item["strand"] == "-":
        sequence = revcomp(sequence)
    return dict(item_id=item["id"], sequence=sequence, offset=offset, total=total,
                next_offset=stop if stop < total else None, source="assembly", allele=allele, orientation=item["strand"])


def annotate_read_evidence(items, sv_clusters, *, matching_policy=None):
    """Legacy geometry candidates, never exact support or a novelty decision.

    Keep every compatible cluster/occurrence link and both edit spans. The
    old read_support field is the first candidate only; its count must not
    be unioned with other clusters or promoted to sequence-allele carriage.
    Full normalization/compound comparison uses the typed shared provider when
    complete sequence is requested. This light adapter stays sequence-free.
    """
    from services.differences.matching import Edit, MatchingPolicy, candidate_relation
    from services.differences.model import EquivalenceLink
    from dataclasses import asdict
    policy = matching_policy or MatchingPolicy()

    def shape(value, assembly=False):
        if assembly and "t_start" in value:
            return value["t_start"], value["ref_bp"], value["alt_bp"]
        t, length = value.get("t"), value.get("len", 0)
        return value.get("ref", 0), value.get("ref_len", length if t == "D" else 0), value.get("alt_len", length if t == "I" else 0)

    indexed = []
    for i, cluster in enumerate(sv_clusters):
        if cluster.get('source', 'reads') != 'reads' or cluster.get('t') not in ('I', 'D'):
            continue
        cp, cr, ca = shape(cluster)
        # Historical uncertainty may be a measurement CI. It is not a proven
        # repeat-equivalence interval and cannot expand normalized identity.
        indexed.append((cp, i, Edit('legacy-read', 'legacy-reference', 'region', cp, cp + cr, ca, 'reads')))
    indexed.sort(key=lambda entry: entry[:2])
    starts = [p for p, _, _ in indexed]
    largest = max((max(e.ref_bp, e.alt_bp) for _, _, e in indexed), default=0)

    matched = set()
    for item in items:
        item.pop("read_support", None)
        item.pop("read_candidates", None)
        item.pop("equivalence_links", None)
        if (item.get("kind") not in ("insertion", "deletion", "replacement")
                and (item.get("kind") is not None or item.get("t") not in ("I", "D"))):
            continue
        links = []
        p, r, a = shape(item, True)
        left = Edit('legacy-assembly', 'legacy-reference', 'region', p, p + r, a, 'assembly')
        tolerance = max(policy.broad_anchor_bp, policy.broad_anchor_fraction * max(r, a, largest))
        candidates = indexed[bisect.bisect_left(starts, p - tolerance):bisect.bisect_right(starts, p + tolerance)]
        for _cp, i, right in sorted(candidates, key=lambda entry: entry[1]):
            c = sv_clusters[i]
            method = candidate_relation(left, right, policy)
            if method:
                p, r, a = shape(item, True)
                cp, cr, ca = shape(c)
                links.append(dict(cluster=i, carriers=c.get("support", len(c.get("members", ()))),
                                  relation="candidate", method="geometry_only", sequence_comparison="unassessed",
                                  assembly_span=dict(start=p, end=p + r, ref_bp=r, alt_bp=a),
                                  read_span=dict(start=cp, end=cp + cr, ref_bp=cr, alt_bp=ca),
                                  uncertainty=list(c.get("uncertainty", (cp, cp)))))
                links[-1]["candidate_policy"] = policy.version
                links[-1]["candidate_rule"] = method
                matched.add(i)
        if links:
            item["read_candidates"] = links
            item["read_support"] = {k: links[0][k] for k in ("cluster", "carriers")}
            item["equivalence_links"] = [asdict(EquivalenceLink(
                ((item.get("id", "legacy-assembly"),), ("legacy-cluster:" + str(link["cluster"]),)), "candidate",
                policy_versions={"matching": policy.version},
                reasons=(link["candidate_rule"], "sequence_unavailable", "legacy_cluster_scope"))) for link in links]
    unmatched = []
    for i, c in enumerate(sv_clusters):
        if i in matched or c.get("source", "reads") != "reads":
            continue
        p, r, _a = shape(c)
        lo, hi = c.get("uncertainty", (p, p))
        reasons = {d["kind"] for d in items if d.get("kind") in ("no_correspondence", "aligned_bubble")
                   and d["t_start"] <= hi + r and d["t_end"] >= lo}
        reasons.add("incomplete_assembly_comparison")
        unmatched.append({**{k: v for k, v in c.items() if k != "members"}, "source": "reads",
                          "novelty": "unassessed", "novelty_reasons": sorted(reasons)})
    return unmatched


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


def _haplotype_reference(ctx, hap, start, end):
    """Target-oriented assembly bases for a molecule aligned to another parent.
    Multiple primary projections, missing FASTA and uncovered bases stay unknown.
    Cached per inspection window; alignment-contig MD cannot establish this allele.
    """
    import numpy as np

    cache = ctx._mismatch_windows
    key = ("hap", hap, start, end)
    if key not in cache:
        expected = np.full(end - start, ord("N"), dtype=np.uint8)
        count = np.zeros(end - start, dtype=np.uint8)
        flags = np.zeros(end - start, dtype=np.uint8)
        with ctx.handle.lock:
            pieces = ctx.handle.map.target_to_source(ctx.selection.chrom, start, end)
        for p in pieces:
            c = ctx.handle.map.chains[p.chain]
            if not p.primary or c["haplotype"] != hap:
                continue
            contig = ctx.handle.manifest["sources"][c["source"]]["name"]
            ref = fasta_bases(getattr(ctx, "source_fasta", None), contig, p.q_start, p.q_end)
            lo, hi = p.t_start - start, p.t_end - start
            count[lo:hi] += 1
            if ref is not None and len(ref) == hi - lo:
                expected[lo:hi] = np.frombuffer((revcomp(ref) if p.strand == "-" else ref).encode("ascii"), dtype=np.uint8)
            with ctx.handle.lock:
                inferred = ctx.handle.map.inferred_runs(p.chain, p.t_start, p.t_end)
            for t, n, kind in inferred:
                flags[max(t, p.t_start) - start:min(t + n, p.t_end) - start] = (1 if kind == "substitution" else 2 if kind == "aligned" else 0)
        expected[count != 1] = ord("N")
        cache[key] = expected.tobytes().decode("ascii"), flags
    return cache[key]


def row_mismatches(read, row, ctx, hap=None):
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
    import numpy as np

    out = []
    detail_start, detail_end = ctx.loader_options.get("detail_view", (ctx.region_start, ctx.region_end))
    start, end = max(ctx.region_start, detail_start), min(ctx.region_end, detail_end)
    if end <= start:
        return out
    # One target fetch and one inferred-run sweep per chain/window, shared by
    # all records. NumPy compares contiguous slices; Python sees only X sites.
    cache = getattr(ctx, "_mismatch_windows", None)
    if cache is None:
        ctx._mismatch_windows = cache = {}
    if "target" not in cache:
        cache["target"] = fasta_bases(ctx.loader_options["target_fasta"], ctx.selection.chrom, start, end)
    target = cache["target"]
    if target is None:
        return out
    for f in row.frags:
        a, b = max(start, f.t0), min(end, f.t1)
        if b <= a:
            continue
        if f.p.chain not in cache:
            flags = np.zeros(end - start, dtype=np.uint8)
            with ctx.handle.lock:
                inferred = ctx.handle.map.inferred_runs(f.p.chain, start, end)
            for t, n, kind in inferred:
                flags[max(start, t) - start:min(end, t + n) - start] = (1 if kind == "substitution" else 2 if kind == "aligned" else 0)
            cache[f.p.chain] = flags
        flags = cache[f.p.chain]
        qlo = f.p.q_start + (f.p.t_end - b if f.minus else a - f.p.t_start)
        qhi = qlo + b - a
        source_key = ("source", f.p.chain, qlo, qhi)
        if source_key not in cache:
            cache[source_key] = fasta_bases(getattr(ctx, "source_fasta", None), record.get("contig"), qlo, qhi)
        source_ref = cache[source_key]
        for r0, q0, n in zip(runs.ref, runs.seq, runs.len):
            lo = max(r0, f.s, qlo, r0 + lead - q0)
            hi = min(r0 + n, f.e, qhi, r0 + lead - q0 + len(seq))
            if hi <= lo:
                continue
            qi = q0 + lo - r0 - lead
            bases = seq[qi:qi + hi - lo].upper()
            hg = source_ref[lo - qlo:hi - qlo] if source_ref is not None else None
            if hg is None and read.get("_fiberbrowser_md") is not None:
                expected = bytearray(bases.encode("ascii"))
                for x, base in md.items():
                    if lo <= x < hi:
                        expected[x - lo] = ord(base)
                hg = expected.decode("ascii")
            if f.minus:
                bases, hg = revcomp(bases), revcomp(hg) if hg is not None else None
            t = min(f.T(lo), f.T(hi - 1))
            alignment_hg = hg
            own_flags = None
            if hap is not None and hap != f.p.hap:
                own, own_flags = _haplotype_reference(ctx, hap, start, end)
                hg = own[t - start:t - start + len(bases)]
            rb = target[t - start:t - start + len(bases)]
            observed = np.frombuffer(bases.encode("ascii"), dtype=np.uint8)
            reference = np.frombuffer(rb.encode("ascii"), dtype=np.uint8)
            mapped = (own_flags if own_flags is not None else flags)[t - start:t - start + len(bases)]
            hg_array = np.frombuffer(hg.encode("ascii"), dtype=np.uint8) if hg is not None else None
            is_ref = ((mapped == 1) & (hg_array != ord("N")) & (hg_array != reference) & (observed == reference)
                      if hg_array is not None else np.zeros(len(bases), dtype=bool))
            for i in np.flatnonzero((observed != reference) | is_ref):
                base = bases[i]
                ev = dict(type="X", pos=t + int(i) - ctx.region_start, base=base, ref=rb[i],
                          source="assembly" if mapped[i] and hg is not None and hg[i] != "N" and hg[i] == base else "reads", len=1, seq=base)
                if hap is not None and hap != f.p.hap:
                    ev["hg002"] = hg[i] if hg is not None and hg[i] != "N" else None
                    ev["alignment_hg002"] = alignment_hg[i] if alignment_hg is not None else None
                if is_ref[i]:
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
        # Gaps have independent ref/alt spans. An interior target point has
        # no affine source projection, even for a one-base replacement alt.
        gaps = [d for d in assembly_items_for_region(config, chrom, pos, end, lift_hap=lift_hap)
                if d["kind"] in ("deletion", "replacement") and d["t_start"] <= pos and d["t_end"] >= end]
        gap_haps = {d["hap"] for d in gaps}
        with handle.lock:
            pieces = handle.map.target_to_source(chrom, pos, end)
        grouped = {}
        for p in pieces:
            c = handle.map.chains[p.chain]
            hap = c["haplotype"]
            if not p.primary or hap not in haps or hap in gap_haps:
                continue
            if p.chain in grouped:
                v = grouped[p.chain]
                v["src"]["start"] = min(v["src"]["start"], p.q_start)
                v["src"]["end"] = max(v["src"]["end"], p.q_end)
            else:
                grouped[p.chain] = _item(handle, hap, p.chain, "inspection", "inspection", pos, end, p.q_start, p.q_end)
        spans = gaps + list(grouped.values())
        # Keep missing correspondence explicit when no raw gap owns it.
        present = {span["hap"] for span in spans}
        for hap in haps:
            if hap not in present:
                spans.append(_item(handle, hap, None, "no_correspondence", "no_correspondence", pos, end, None, None))
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
            if a < r <= b or a == b == r:
                bases.append(seq[q:q + n])
                inserted += n
            q += n
        elif op in (2, 3):
            if op == 2:
                deleted += max(0, min(b, r + n) - max(a, r))
            r += n
        elif op == 4:
            q += n
    ref = "" if a == b else fasta_bases(source_fasta, record.reference_name, a, b)
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


def difference_reads(state, dataset, chrom, pos, end, *, lift_hap=None, item_id=None, include_sequence=False):
    """Bounded source-record inspection; see the module docstring for JSON.
    An in-memory BAM adapter lets the ordinary display composer decode the
    same <=500 fetched records when a broad cache is absent. Primary metadata
    is resolved separately with the ordinary bounded SA point-lookup budget.
    """
    import hashlib
    import time
    from contextlib import ExitStack
    import pysam
    from services.lift.reads import lifted_reads_for_region, filter_lift_display

    from services.read_auxiliary_endpoint import _cached_lift_rows

    config = dataset.live_lift
    selected = next((d for d in assembly_items_for_region(config, chrom, pos, max(pos + 1, end))
                     if item_has_id(d, item_id)), None) if item_id else None
    if selected is not None:
        pos, end = selected["t_start"], selected["t_end"]
    spans = _inspection_spans(config, chrom, pos, end, None)
    preferred = selected["hap"] if selected else (next(iter(_haps(config, lift_hap)), None) if lift_hap else None)
    preferred_label = config.handle.haplotype_labels.get(preferred, preferred)
    spans.sort(key=lambda s: s["hap"] != preferred)
    if any(s["src"]["start"] is not None and s["src"]["end"] - s["src"]["start"] > 50_000 for s in spans):
        from services.lift.live_lift import LiftRefused
        raise LiftRefused("Live lift: this alternate span exceeds the 50 kb inspection limit")
    if end - pos > 50_000:
        from services.lift.live_lift import LiftRefused
        raise LiftRefused("Live lift: this reference span exceeds the 50 kb inspection limit")
    rows, capped = [], False
    selected_sequence = None
    sequence_score = None
    view_start = max(0, pos - 50)
    view_end = min(config.handle.target_size(chrom) or max(pos + 1, end) + 50, max(pos + 1, end) + 50)
    # Broad display caches may be sampled, annotation-free or missing individual
    # records. Decode complete annotations on this bounded cohort, so both its
    # membership and its chromatin are independent of display cache history.
    display, broad_key = _cached_lift_rows(state, dataset, chrom, view_start, view_end, time.time(), annotations=True)
    origin = broad_key[2] if broad_key else view_start

    class _Records:
        def __init__(self, bam, records):
            self.bam, self.records = bam, records
            self.primary_metadata_bam = bam

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
                if src["start"] is None or src["contig"] not in bam.references:
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
        from services.lift.live_lift import resolve_primary_metadata, molecule_key
        from services.read_strand import record_strand_fields
        metadata_reads = [dict(id=r.query_name, source_path=path,
                               _fiberbrowser_lift_record=dict(contig=r.reference_name),
                               _fiberbrowser_primary=dict(is_supplementary=r.is_supplementary,
                                                          sa=r.get_tag("SA") if r.has_tag("SA") else None),
                               **record_strand_fields(r)) for path, r, _ in fetched]
        molecules = resolve_primary_metadata(config.handle, metadata_reads, settings=config.settings, counts={},
                                             bam_handle_getter=lambda p: adapters[p].bam)
        available = {(r.get("source_path"), (r.get("live_lift") or {}).get("record")) for r in display or []}
        if fetched and (display is None or any((path, rid) not in available for path, _, rid in fetched)):
            origin = view_start
            # Missing paths after the cap are empty adapters, never real BAM
            # handles, so the display fallback stays inside this exact cohort.
            empty = _Records(next(iter(adapters.values())).bam, [])
            display = lifted_reads_for_region(dataset, chrom, view_start, view_end,
                                               dict(include_layers=True, include_methylation=True,
                                                    insertion_ids=[s["id"] for s in spans
                                                                   if s["kind"] in ("insertion", "replacement")]),
                                               bam_handle_getter=lambda p: adapters.get(p, empty),
                                               primary_metadata=molecules)
        display = filter_lift_display(display or [], dataset, None)
        by_record = {}
        for row in display:
            ll = row.get("live_lift") or {}
            by_record.setdefault((row.get("source_path"), ll.get("record")), []).append(row)
        ref = fasta_bases(getattr(state, "fasta", None), chrom, pos, end)
        expected = {}
        for span in spans:
            src = span["src"]
            value = None
            if src["start"] is not None:
                value = "" if src["start"] == src["end"] else fasta_bases(source, src["contig"], src["start"], src["end"])
                if value is not None and span["strand"] == "-":
                    value = revcomp(value)
                if value is None:
                    values = set()
                    for _, rec, _ in fetched:
                        if (rec.reference_name == src["contig"] and rec.reference_start <= src["start"]
                                and rec.reference_end >= src["end"]):
                            _, hg, _, _, _ = _record_alleles(rec, src["start"], src["end"], source)
                            if hg is not None:
                                values.add(revcomp(hg) if span["strand"] == "-" else hg)
                    value = next(iter(values)) if len(values) == 1 else None
            expected.setdefault(span["hap"], []).append(value)
        expected = {hap: values[0] if len(values) == 1 else None for hap, values in expected.items()}
        for path, record, record_id in fetched:
            candidates = by_record.get((path, record_id), [])
            for span in spans:
                src = span["src"]
                a, b = src["start"], src["end"]
                if a is None or record.reference_name != src["contig"]:
                    continue
                gap = span["kind"] in ("deletion", "replacement")
                if not (record.reference_start <= a <= record.reference_end if gap and a == b else
                        record.reference_start < max(a + 1, b) and record.reference_end > a):
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
                alignment_hg = hg
                meta = molecules.get(molecule_key(dict(source_path=path, id=record.query_name)), {})
                hap = meta.get("hap") or span["hap"]
                hg = alignment_hg if hap == span["hap"] else expected.get(hap)
                allele = ("no_coverage" if not overlaps else "deleted" if not rb else "unknown" if hg is None else
                          ("hg002" if rb == hg and len(hg) != end - pos else "unknown") if ref is None else
                          "hg002" if hg is not None and ref is not None and rb == hg and hg != ref else
                          "same_as_grch38" if hg is not None and ref is not None and rb == hg == ref else
                          "grch38" if hg is not None and ref is not None and hg != ref and rb == ref else "other")
                if gap:
                    left_flank = bool(a > 0 and record.get_overlap(a - 1, a))
                    right_flank = bool(record.get_overlap(b, b + 1))
                    full = left_flank and right_flank
                    if a == b and not (left_flank or right_flank):
                        overlaps = False
                    allele = ("no_coverage" if not overlaps else "partial" if not full else allele)
                carries = False
                alternate = pos == end or span["kind"] == "replacement"
                if alternate:
                    if pos == end:
                        full = record.reference_start <= a and record.reference_end >= b
                    length = b - a
                    carries = full and bool(rb) and (length == 0 or abs(len(rb) - length) <= max(length * .1, 50))
                    own_spans = [s for s in spans if s["hap"] == hap]
                    own = own_spans[0] if len(own_spans) == 1 else None
                    if pos == end:
                        allele = ("no_coverage" if not overlaps else "partial" if not full else
                                  "unknown" if hg is None else
                                  "no_insertion" if not rb and not hg else "deleted" if not rb else
                                  "hg002" if carries and (hap == span["hap"] or rb == hg) and bool(hg) else "other")
                st = meta.get("strand") if meta else (record.get_tag("st") if record.has_tag("st") else None)
                item = dict(id=record.query_name, molecule=ll.get("molecule", f"{dataset.id}|{record.query_name}"),
                            hap_label=config.handle.haplotype_labels.get(hap, hap), record=ll.get("record", record_id),
                            supplementary=bool(record.is_supplementary), strand=st, source_pos=dict(src),
                            read_bases=rb[:60], read_bases_length=len(rb), hg002=hg,
                            alignment_hg002=alignment_hg, grch38=ref, allele=allele,
                            chromatin=_chromatin(row, origin, pos, span["strand"]))
                if gap:
                    item.update(item_id=span["id"], ref_bp=span["ref_bp"], alt_bp=span["alt_bp"],
                                full_span=full, left_flank=left_flank, right_flank=right_flank,
                                carries_deletion=bool(span['kind'] == 'deletion' and full and not rb and hap == span['hap']),
                                mol_bp=len(rb), read_bases=rb[:60], read_bases_length=len(rb))
                if alternate:
                    own_carrier = carries and hap == span["hap"]
                    if (include_sequence and own_carrier
                            and (item_id is None or span["id"] == (selected["id"] if selected else item_id))
                            and len(rb) <= 50_000):
                        score = (span["hap"] != preferred if preferred else False,
                                 abs(len(rb) - length), bool(record.is_supplementary), record_id)
                        if sequence_score is None or score < sequence_score:
                            sequence_score = score
                            selected_sequence = dict(sequence=rb, read_id=record.query_name, record=record_id,
                                                     ins_id=span["id"], orientation=span["strand"], source="reads")
                    item.update(carries_insertion=carries, mol_bp=len(rb), identity=identity,
                                read_bases=rb[:60], read_bases_length=len(rb))
                    if span["kind"] in ("insertion", "replacement"):
                        item["alignment_ins_id"] = span["id"]
                    if own:
                        item["ins_id"] = own["id"]
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
                summary=summary, preferred_hap=preferred_label, capped=capped, max_records=500,
                sequence=selected_sequence,
                hap_status={s["hap_label"]: ("aligned" if s["kind"] == "inspection" else s["kind"]) for s in spans})
