"""Assembly comparison for the Differences row, inspector and table.

This is the production caller of the phase-2 providers: map items become
assembly Differences (``assembly.assembly_difference``) with ledger identities
(``identity.IdentityLedger``); complete alleles get exact IDs
(``matching.reconstruct``/``canonicalize``); read differences are matched with
``matching.match_edits``; and each read difference gets a ``matching.novelty``
decision over an explicitly built ``ComparisonScope``.

Labels follow the design's terminology (§1, §8):

- ``confirmed_by_assembly``: an exact link, i.e. full changed haplotypes are
  equal. Only complete sequences can produce it: a read deletion is complete
  from its reference span; a read insertion or replacement is complete only
  when the caller supplies its observed consensus (``read_sequences``).
- ``assembly_supported_approximate``: a geometry candidate whose complete
  read and assembly alternates align at or above
  ``ComparisonPolicy.approximate_min_identity``. Phase 2 left approximate
  support off for want of a calibrated threshold; the threshold here is an
  engineering default, exposed and saved, and the score is always shown.
- ``assembly_candidate``: geometry only, sequence comparison unassessed.
- otherwise the novelty status: ``novel_relative_to_assembly`` only after a
  complete comparison, else ``unassessed`` with reasons.

No label adds or moves a molecule vote. Exact enrichment is offered through
``exact_targets``: frozen exact targets built from complete assembly alleles,
with every complete competing assembly allele at the locus and the reference.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, replace
import os

from services.reconstruction_budget import ResourceResult
from .identity import IdentityLedger, content_id, digest_file
from .matching import (ComparisonScope, Edit, MatchingPolicy, ReferenceWindow, candidate_relation,
                       match_edits, novelty, reconstruct)
from .model import Phase

COMPARISON_VERSION = "assembly-comparison:v1"
LOCAL_KINDS = ("insertion", "deletion", "replacement", "snv", "mnv")
CONTEXT_KINDS = ("aligned_bubble", "no_correspondence", "inversion")
LABELS = {
    "confirmed_by_assembly": "Confirmed by assembly",
    "assembly_supported_approximate": "assembly-supported (approximate)",
    "assembly_candidate": "Assembly candidate (geometry only)",
    "novel_relative_to_assembly": "Not in the compared assembly haplotypes",
    "unassessed": "Assembly comparison unassessed",
    "reads_only": "Reads only (no assembly)",
}


@dataclass(frozen=True)
class ComparisonPolicy:
    version: str = COMPARISON_VERSION
    evidence_floor_bp: int = 10
    approximate: bool = True
    approximate_min_identity: float = 0.90
    max_approximate_cells: int = 25_000_000
    max_assembly_items: int = 512
    max_read_differences: int = 256
    max_allele_bp: int = 50_000
    halo_bp: int = 1000
    diagnostic_flank_bp: int = 25
    max_ledger_records: int = 2000

    def __post_init__(self):
        if not 0.5 <= self.approximate_min_identity <= 1:
            raise ValueError("approximate_min_identity must be within [0.5, 1]")
        for key in ("evidence_floor_bp", "max_approximate_cells", "max_assembly_items", "max_read_differences",
                    "max_allele_bp", "halo_bp", "diagnostic_flank_bp", "max_ledger_records"):
            if type(getattr(self, key)) is not int or getattr(self, key) <= 0:
                raise ValueError("positive integer comparison limits required")


def reference_content_id(fasta) -> str:
    """Namespace of the loaded target reference: its index (names, lengths,
    offsets) and size. Explicitly an index-level identity, not a sequence hash."""
    path = getattr(fasta, "filename", None)
    if isinstance(path, bytes):
        path = os.fsdecode(path)
    if not path:
        raise ResourceResult("unavailable", "reference_unavailable")
    index = path + ".fai"
    return content_id("reference-index:v1", [digest_file(index) if os.path.exists(index) else None,
                                             os.path.getsize(path)])


def _map_content_id(config, chrom):
    handle = config.handle
    files = handle.manifest.get("target_files", {}).get(chrom, [])
    return content_id("map-target-content:v1", [digest_file(handle.path), *[
        digest_file(os.path.join(handle.map.dir, name)) for name in files]])


class _Reference:
    """Bounded, cached target-reference windows for one request."""

    def __init__(self, fasta, reference_id, chrom, halo):
        from utils.chrom import resolve_reference_name
        self.fasta, self.reference_id, self.chrom, self.halo = fasta, reference_id, chrom, halo
        self.name = resolve_reference_name(chrom, fasta.references) if fasta is not None else None
        self.length = fasta.get_reference_length(self.name) if self.name else None
        self.cache = {}

    def bases(self, start, end):
        if self.name is None:
            return None
        start, end = max(0, start), min(self.length, end)
        key = (start, end)
        if key not in self.cache:
            self.cache[key] = self.fasta.fetch(self.name, start, end).upper()
            if len(self.cache) > 256:
                self.cache.pop(next(iter(self.cache)))
        return self.cache[key]

    def window(self, reference_id, contig, start, end):
        if reference_id != self.reference_id or contig != self.chrom or self.name is None:
            return None
        lo, hi = max(0, start - self.halo), min(self.length, end + self.halo)
        sequence = self.bases(lo, hi)
        if sequence is None or len(sequence) != hi - lo:
            return None
        return ReferenceWindow(reference_id, contig, lo, sequence, self.length)


def _source_allele(source, item, max_bp):
    """Full target-oriented assembly alternate, or None when unknown."""
    from services.lift.compose import revcomp
    from services.lift.differences import fasta_bases
    if item["kind"] == "deletion":
        return ""
    src = item.get("src") or {}
    if source is None or src.get("start") is None or src["end"] - src["start"] != item["alt_bp"]:
        return None
    if item["alt_bp"] > max_bp:
        return None
    bases = fasta_bases(source, src["contig"], src["start"], src["end"])
    if bases is None or len(bases) != item["alt_bp"]:
        return None
    return revcomp(bases) if item.get("strand") == "-" else bases


def _identity(read, assembly, policy):
    """Alignment identity of two complete alternates, budgeted before allocation."""
    from services.insertion_consensus import _banded_align, band_width, encode, read_to_consensus_knots
    if not read or not assembly:
        return None, "empty_alternate"
    width = band_width(len(read), len(assembly))
    if (len(read) + 1) * (2 * width + 1) > policy.max_approximate_cells:
        return None, "approximate_budget_exceeded"
    a, b = encode(read), encode(assembly)
    _, identity = read_to_consensus_knots(_banded_align(a, b, int(width)), a, b)
    return round(identity, 4), None


def _overlaps(item, start, end):
    a, z = item["t_start"], item["t_end"]
    return a < end and z > start or a == z and start <= a <= end


def assembly_comparison(state, dataset, *, chrom, start, end, reads=(), read_sequences=None, read_scope=None,
                        ledger=None, matching_policy=None, policy=None):
    """One bounded comparison of a region's assembly items and read differences."""
    from services.background_work import checkpoint
    from services.lift.differences import assembly_items_for_region
    from services.lift.registration import require_enabled
    require_enabled()
    if dataset is None or dataset.data_type != "bam_livelift":
        raise ValueError("assembly comparison requires a live-lift dataset (its map is the assembly)")
    if not 0 <= start < end or end - start > 2_000_000:
        raise ValueError("bounded nonempty region of at most 2 Mb required")
    policy = policy or ComparisonPolicy()
    matching_policy = matching_policy or MatchingPolicy()
    read_sequences = dict(read_sequences or {})
    read_scope = dict(read_scope or {})
    reads = list(reads)
    if len(reads) > policy.max_read_differences:
        raise ValueError(f"at most {policy.max_read_differences} read differences per comparison")
    config = dataset.live_lift
    if chrom not in config.handle.map.targets:
        raise ResourceResult("unavailable", "chromosome_not_in_map")
    reasons = set()
    fasta = getattr(state, "fasta", None)
    reference_id = reference_content_id(fasta) if fasta is not None else None
    if reference_id is None:
        reasons.add("reference_unavailable")
        reference_id = content_id("unresolved-reference:v1", chrom)
    map_id = _map_content_id(config, chrom)
    reference = _Reference(fasta, reference_id, chrom, policy.halo_bp)
    radius = max(matching_policy.broad_anchor_bp, policy.diagnostic_flank_bp)
    widest = max([0, *(max(r["ref_end"] - r["ref_start"], r["alt_bp"]) for r in reads)])
    pad = int(max(radius, matching_policy.broad_anchor_fraction * widest)) + radius
    all_items = assembly_items_for_region(config, chrom, max(0, start - pad), end + pad)
    context = [i for i in all_items if i["kind"] in CONTEXT_KINDS]
    local_all = [i for i in all_items if i["kind"] in LOCAL_KINDS]   # every local edit, including sub-floor SNVs
    items = [i for i in local_all if max(i["ref_bp"], i["alt_bp"]) >= policy.evidence_floor_bp]
    dropped = []
    if len(items) > policy.max_assembly_items:
        reasons.add("assembly_items_cap")
        ranked = sorted(items, key=lambda i: -max(i["ref_bp"], i["alt_bp"]))
        items, dropped = ranked[:policy.max_assembly_items], ranked[policy.max_assembly_items:]
        items.sort(key=lambda i: (i["t_start"], i["hap_label"]))
    labels = config.labels() if hasattr(config, "labels") else {}
    haps = tuple(sorted({i["hap"] for i in all_items} | set(getattr(config, "haplotypes", ()) or ())))
    book = IdentityLedger(ledger) if ledger else IdentityLedger()
    source = None
    if config.source_fasta:
        from services.lift.dataset import open_source_fasta
        source = open_source_fasta(config.source_fasta)
    else:
        reasons.add("assembly_sequence_unavailable")
    assembly, edits, by_observation = {}, [], {}
    try:
        from .assembly import assembly_difference
        for item in items:
            checkpoint()
            alt = _source_allele(source, item, policy.max_allele_bp)
            entry = dict(item, alt=alt, alt_truncated=alt is None)
            phase = Phase(sample_id=map_id, phase_set_id=map_id, haplotype=item["hap"], provenance="map_occurrence")
            if len(book.data["records"]) < policy.max_ledger_records:
                adapted = assembly_difference(entry, reference_id=reference_id, map_content_id=map_id,
                                              target_contig=chrom, ledger=book, phase=phase)
                persisted = True
            else:
                reasons.add("ledger_capacity")
                adapted = assembly_difference(entry, reference_id=reference_id, map_content_id=map_id,
                                              target_contig=chrom, ledger=IdentityLedger(), phase=phase)
                persisted = False
            difference, observation = adapted["difference"], adapted["observations"][0]
            exact_id, canonical = None, None
            window = reference.window(reference_id, chrom, item["t_start"], item["t_end"]) if alt is not None else None
            edit = Edit(observation["observation_id"], reference_id, chrom, item["t_start"], item["t_end"],
                        item["alt_bp"], "assembly", alt, kind=item["kind"], phase=phase,
                        path_id=f"{item['hap']}:{item.get('chain')}", sequence_complete=alt is not None)
            if window is not None:
                try:
                    _, canonical = reconstruct((edit,), window, matching_policy)
                    exact_id = canonical.exact_allele_id
                except (ValueError, ResourceResult) as exc:
                    reasons.add(exc.reason if isinstance(exc, ResourceResult) else str(exc).split(":")[0])
            if exact_id and persisted:
                try:
                    book.resolve_exact(difference["difference_id"], exact_id)
                except ValueError:
                    reasons.add("normalization_lineage_required")
            record = book.data["records"].get(difference["difference_id"], {}) if persisted else {}
            assembly[item["id"]] = dict(
                item_id=item["id"], difference_id=difference["difference_id"], persisted=persisted,
                observation_id=observation["observation_id"], hap=item["hap"], hap_label=item["hap_label"],
                kind=item["kind"], t_start=item["t_start"], t_end=item["t_end"], ref_bp=item["ref_bp"],
                alt_bp=item["alt_bp"], sequence_status="available" if alt is not None else "unavailable",
                identity_state=record.get("identity_state", "exact" if exact_id else "provisional"),
                exact_allele_id=exact_id,
                equivalent_anchors=list(canonical.equivalent_anchors) if canonical else None,
                normalization_complete=bool(canonical and canonical.normalization_complete),
                shared_with=[], read_links=[], alt=alt)
            edits.append(edit)
            by_observation[edit.observation_id] = item["id"]
    finally:
        if source is not None:
            source.close()
    # Haplotypes carrying the same normalized allele share its exact ID.
    by_exact = {}
    for value in assembly.values():
        if value["exact_allele_id"]:
            by_exact.setdefault(value["exact_allele_id"], []).append(value["item_id"])
    for ids in by_exact.values():
        for i in ids:
            assembly[i]["shared_with"] = [j for j in ids if j != i]

    read_edits, read_out = [], {}
    for r in reads:
        checkpoint()
        rid = str(r["id"])
        s, e, a = int(r["ref_start"]), int(r["ref_end"]), int(r["alt_bp"])
        seq = read_sequences.get(rid)
        if seq is not None:
            seq = seq.upper()
            if len(seq) > policy.max_allele_bp or any(c not in "ACGTN" for c in seq):
                raise ValueError("read sequences must be at most max_allele_bp bases of ACGTN")
            a = len(seq)
        complete = a == 0 or (seq is not None and "N" not in seq)
        alt = "" if a == 0 else seq if complete else None
        kind = "deletion" if a == 0 else "insertion" if s == e else "replacement"
        read_edits.append(Edit(f"reads:{rid}", reference_id, chrom, s, e, a, "reads", alt, kind=kind,
                               sequence_complete=complete))
        read_out[rid] = dict(read_id=rid, ref_start=s, ref_end=e, alt_bp=a, kind=kind,
                             sequence_status="available" if complete else "unavailable",
                             sequence_source="consensus" if seq is not None else "geometry" if a == 0 else None,
                             links=[], members=[list(m) for m in r.get("geometry_members") or [[s, e, int(r["alt_bp"])]]])
    result = match_edits(read_edits, edits, window_provider=reference.window, policy=matching_policy) if read_edits and edits else dict(
        links=[], compounds=[], search_complete=True, reasons=[], unassessed_observations=[])
    reasons |= set(result.get("reasons", []))
    raw_links = list(result.get("links", []))
    alts = {e.observation_id: e.alt for e in edits}
    read_alts = {e.observation_id: e.alt for e in read_edits}
    for link in raw_links:
        checkpoint()
        left, right = link["endpoints"]
        rid = left[0].removeprefix("reads:") if len(left) == 1 else None
        if rid is None:
            continue
        rule = next((x for x in link.get("reasons", []) if x in ("narrow", "near_pure", "approximate_search")), None)
        relation, scores = link["relation"], dict(link.get("scores") or {})
        if (relation == "candidate" and policy.approximate and len(right) == 1 and rule in ("narrow", "near_pure")
                and read_alts.get(left[0]) and alts.get(right[0])):
            identity, why = _identity(read_alts[left[0]], alts[right[0]], policy)
            if identity is not None:
                scores["identity"] = identity
                if identity >= policy.approximate_min_identity:
                    relation = "approximate"
            elif why:
                reasons.add(why)
        targets = [by_observation[o] for o in right if o in by_observation]
        compact = dict(assembly_item_ids=targets, hap_labels=sorted({assembly[t]["hap_label"] for t in targets}),
                       relation=relation, rule=rule, compound=len(right) > 1, scores=scores,
                       reasons=list(link.get("reasons", [])), phase_relation=link.get("phase_relation"))
        read_out[rid]["links"].append(compact)
        for t in targets:
            assembly[t]["read_links"].append(dict(read_id=rid, relation=relation, rule=rule, scores=scores))
    for rid, value in read_out.items():
        s, e = value["ref_start"], value["ref_end"]
        nearby = (s - pad, e + pad)
        near_items = [assembly[i["id"]] for i in items if _overlaps(i, *nearby)]
        links = [dict(relation=l["relation"]) for l in value["links"]]
        scope = ComparisonScope(
            assemblies=(map_id,), haplotypes=haps,
            discovery_complete=bool(read_scope.get("search_complete")),
            correspondence_complete=not any(i["kind"] == "no_correspondence" and _overlaps(i, *nearby) for i in context),
            sequence_complete=value["sequence_status"] == "available" and all(v["sequence_status"] == "available" for v in near_items),
            representations_complete=bool(result.get("search_complete", True)),
            search_complete=bool(result.get("search_complete", True)) and "assembly_items_cap" not in reasons,
            bubbles_resolved=not any(i["kind"] == "aligned_bubble" and _overlaps(i, *nearby) for i in context),
            reasons=tuple(sorted(r for r in reasons if r in ("reference_unavailable", "assembly_sequence_unavailable"))))
        # Representations the matcher cannot compare (inversions) or items the cap dropped near this
        # difference leave the comparison incomplete: never a "not in the assembly" verdict over them.
        unsupported = [i for i in context if i["kind"] == "inversion" and _overlaps(i, *nearby)]
        capped_here = [i for i in dropped if _overlaps(i, *nearby)]
        if unsupported or capped_here:
            scope = replace(scope, representations_complete=scope.representations_complete and not unsupported,
                            search_complete=scope.search_complete and not capped_here,
                            reasons=tuple(sorted(set(scope.reasons) | ({"unsupported_representation"} if unsupported else set())
                                                 | ({"assembly_items_cap"} if capped_here else set()))))
        decision = novelty(links, scope)
        status = decision["status"]
        label = ("confirmed_by_assembly" if status == "assembly_equivalent" else
                 "assembly_supported_approximate" if status == "assembly_supported_approximate" else
                 "assembly_candidate" if links else status)
        value.update(label=label, label_text=LABELS[label], novelty=dict(status=status, reasons=decision["reasons"]))
    # Lineage for read discovery groups: observations are their member geometries.
    events = []
    if reads:
        namespace = content_id("read-discovery-scope:v1", [map_id, read_scope.get("dataset_id"), chrom,
                                                           read_scope.get("analysis_scope", "lifted_only"),
                                                           read_scope.get("policy_version")])
        groups = [([content_id("geometry-member:v1", [chrom, *m]) for m in value["members"]],
                   dict(chrom=chrom, ref_start=value["ref_start"], ref_end=value["ref_end"], alt_bp=value["alt_bp"],
                        read_id=rid, members=value["members"], namespace_scope=read_scope))
                  for rid, value in read_out.items()]
        identities, events = book.reconcile(namespace, groups, max_records=policy.max_ledger_records)
        for (rid, value), identity in zip(read_out.items(), identities):
            value["difference_id"] = identity
            if identity is None:
                reasons.add("ledger_capacity")
            else:
                record = book.data["records"][identity]
                value["identity_state"] = record["identity_state"]
            for link in value["links"]:
                if link["relation"] == "exact" and identity is not None and len(link["assembly_item_ids"]) == 1:
                    exact = assembly[link["assembly_item_ids"][0]]["exact_allele_id"]
                    if exact and book.data["records"][identity].get("exact_allele_id") in (None, exact):
                        book.resolve_exact(identity, exact)
                        value["identity_state"], value["exact_allele_id"] = "exact", exact
    for value in assembly.values():
        value["exact_target"] = _exact_target(value, assembly, context, reference, chrom, policy, labels, dropped, local_all)
    for value in assembly.values():
        value.pop("alt")
    return dict(schema_version="differences:v1", comparison_version=COMPARISON_VERSION, dataset_id=dataset.id,
                chrom=chrom, start=start, end=end, reference_id=reference_id, map_content_id=map_id,
                policy=asdict(policy), matching_policy=asdict(matching_policy),
                search_complete=not (reasons - {"assembly_sequence_unavailable"}) and bool(result.get("search_complete", True)),
                reasons=sorted(reasons), assembly=assembly, reads=read_out, compounds=result.get("compounds", []),
                lineage_events=events, ledger=book.payload())


def _exact_target(value, assembly, context, reference, chrom, policy, labels, dropped=(), local_all=()):
    """A frozen exact target with every complete competing assembly allele.

    Each candidate is one haplotype's allele spliced onto the reference over a common diagnostic window. That is
    only that haplotype's true sequence when it has no other edit in the window: the window grows over every nearby
    local edit (any size, including the cap's dropped items), and a target whose own haplotype has another edit
    there gets no exact target; another haplotype with several edits leaves the competition incomplete.
    """
    if not value["exact_allele_id"] or value["alt"] is None:
        return None
    s, e = value["t_start"], value["t_end"]
    flank = policy.diagnostic_flank_bp
    ds, de = max(0, s - flank), e + flank
    nearby = list(local_all) + list(dropped)
    for _ in range(64):   # grow to a fixed point over overlapping edits (bounded)
        inside = [i for i in nearby if i["t_start"] <= de and i["t_end"] >= ds]
        lo = max(0, min([s, *(i["t_start"] for i in inside)]) - flank)
        hi = max([e, *(i["t_end"] for i in inside)]) + flank
        if (lo, hi) == (ds, de):
            break
        ds, de = lo, hi
    if de - ds > policy.max_allele_bp:
        return None
    inside = [i for i in nearby if i["t_start"] <= de and i["t_end"] >= ds]
    own_hap = [i for i in inside if i["hap"] == value["hap"] and i["id"] != value["item_id"]]
    if own_hap:
        return None   # the haplotype's window holds other edits: a single-edit splice would not be its sequence
    window = reference.bases(ds, de)
    if window is None or len(window) != de - ds:
        return None
    changed = lambda v: window[:v["t_start"] - ds] + v["alt"] + window[v["t_end"] - ds:]
    target_id = value["exact_allele_id"]
    candidates = {target_id: changed(value)}
    names = {target_id: [value["hap_label"]]}
    complete = True
    by_hap = {}
    for i in inside:
        by_hap.setdefault(i["hap"], []).append(i)
    for hap, edits in by_hap.items():
        if hap == value["hap"]:
            continue
        compared = [assembly.get(i["id"]) for i in edits]
        if len(edits) > 1 or any(c is None or c["alt"] is None or not c["exact_allele_id"] for c in compared):
            complete = False   # several edits, a sub-floor/dropped edit or missing sequence on this haplotype
            continue
        v = compared[0]
        candidates.setdefault(v["exact_allele_id"], changed(v))
        names.setdefault(v["exact_allele_id"], []).append(v["hap_label"])
    names[target_id] = sorted(set(names[target_id]) | {assembly[i]["hap_label"] for i in value["shared_with"]})
    # Unsupported local representations, and competitors the item cap dropped, leave the competition open.
    if any(c["t_start"] < de and c["t_end"] > ds for c in context) or any(
            d["t_start"] <= de and d["t_end"] >= ds for d in dropped):
        complete = False
    candidates["reference"] = window
    return dict(target_id=target_id, revision=1, target_type="exact", chrom=chrom, ref_start=s, ref_end=e,
                alt_bp=value["alt_bp"], diagnostic_start=ds, diagnostic_end=de, candidates=candidates,
                competition_complete=complete, source="assembly", source_item_id=value["item_id"],
                candidate_labels={k: " / ".join(v) for k, v in names.items()})
