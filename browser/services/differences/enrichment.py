"""Lazy native diagnostic enrichment. No map, chromatin decode or scan mutation.

The ordinary geometry envelope and its frozen cohort remain intact. This
separate revision contains full-interval sequence competition and original
alignment witnesses. Unknown chemistry is the default. No raw SEQ is cached.
"""
from dataclasses import asdict, replace
import json

from services.background_work import checkpoint
from services.reconstruction_budget import DEFAULT_LIMITS, ResourceResult
from .alleles import DafContext
from .calls import Call, MoleculeId, Representation, reconcile_representations, witness_id
from .identity import content_id
from .likelihood import LikelihoodBudget, LikelihoodPolicy, compete


def observe_interval(read, start, end, *, flank=1, max_bases=100_000):
    """Walk source CIGAR in BAM SEQ frame; require observed adjacent flanks.

    Includes insertions at either boundary. D removes reference bases, N is
    unresolved. Hard-clipped/unavailable bases never appear in the observation.
    Reverse SAM SEQ is already in reference orientation; do not complement it
    a second time. Full-molecule witness offsets retain the hard-clip prefix.
    """
    if not 0 <= start <= end or flank < 1:
        raise ValueError("invalid diagnostic interval")
    if end - start > max_bases:
        raise ResourceResult("budget_exceeded", "diagnostic_interval")
    sequence = read.query_sequence
    cigar = read.cigartuples or []
    if sequence is None or not cigar:
        return {"sequence": None, "complete": False, "reason": "seq_unavailable", "query_interval": None, "qualities": ()}
    q, r, intervals, left, right, skipped, boundary_q = 0, int(read.reference_start), [], 0, 0, False, None
    for op, length in cigar:
        checkpoint()
        if op in {0, 7, 8}:
            if r <= start <= r + length and boundary_q is None:
                boundary_q = q + start - r
            left += max(0, min(r + length, start) - max(r, start - flank))
            right += max(0, min(r + length, end + flank) - max(r, end))
            a, b = max(r, start), min(r + length, end)
            if a < b:
                intervals.append((q + a - r, q + b - r))
            q, r = q + length, r + length
        elif op == 1:
            if start <= r <= end:
                intervals.append((q, q + length))
            q += length
        elif op in {2, 3}:
            if r <= start <= r + length and boundary_q is None:
                boundary_q = q
            if op == 3 and r <= end and r + length >= start:
                skipped = True
            r += length
        elif op == 4:
            q += length
        elif op not in {5, 6}:
            skipped = True
    if sum(b - a for a, b in intervals) > max_bases:
        raise ResourceResult("budget_exceeded", "observed_diagnostic_bases")
    bounds = all(0 <= a <= b <= len(sequence) for a, b in intervals)
    contiguous = all(a == previous_b for (_, previous_b), (a, _) in zip(intervals, intervals[1:]))
    complete = bounds and contiguous and not skipped and left == flank and right == flank
    from .alleles import decode_daf_bases
    observed = decode_daf_bases("".join(sequence[a:b] for a, b in intervals)) if bounds else None
    qualities = tuple(quality for a, b in intervals for quality in (read.query_qualities[a:b] if read.query_qualities is not None else ()))
    hard = cigar[0][1] if cigar[0][0] == 5 else 0
    query_interval = ((hard + intervals[0][0], hard + intervals[-1][1]) if intervals else
                      (hard + boundary_q, hard + boundary_q) if boundary_q is not None else None)
    return {"sequence": observed, "complete": complete, "reason": None if complete else "partial_diagnostic_path",
            "query_interval": query_interval, "qualities": qualities}


def _missed_competing_edit(read, start, end, reference, alternate, check):
    """A narrow string cannot exclude an equivalent edit outside its bounds.

    Without reference bases across the competing span, repeat normalization
    cannot prove it distinct. Preserve uncertainty even if legacy geometry
    called this molecule reference. An explicit common window can resolve it.
    """
    if reference is None or alternate is None:
        return False
    net = len(alternate) - len(reference)
    if not net:
        return False
    r, block = int(read.reference_start), None
    spans = []
    for op, length in read.cigartuples or ():
        check()
        if op in {1, 2}:
            if block is None:
                block = [r, r, 0]
            block[2] += length if op == 1 else -length
            if op == 2:
                r += length
                block[1] = r
        else:
            if block is not None:
                spans.append(block)
                block = None
            if op in {0, 3, 7, 8}:
                r += length
    if block is not None:
        spans.append(block)
    return any(delta == net and not start <= a <= b <= end for a, b, delta in spans)


def enrich_native(state, envelope, *, dataset_id, chrom, ref, target_end, specification,
                  include_duplicates=False, policy=LikelihoodPolicy(), records=None):
    """Opt-in full-target request, including *all* competitors and reference.

    specification: target_id, revision, reference, candidates (id -> full string
    or null), competition_complete, optional chemistry_by_name (DafContext
    fields). Caller snapshots are echoed with their own content-scoped revision;
    changing competitors never rewrites the saved geometry target/cohort.
    """
    from services.sv_endpoint import _bam_records, SvRequestError
    if not isinstance(specification, dict):
        raise SvRequestError("allele_target must be an object")
    target = specification.get("target_id")
    candidates = specification.get("candidates")
    reference = specification.get("reference")
    revision = specification.get("revision")
    if (not isinstance(target, str) or not target or target == "reference" or type(revision) is not int or revision < 1
            or not isinstance(candidates, dict) or target not in candidates or "reference" in candidates
            or any(not isinstance(k, str) or not k or (v is not None and not isinstance(v, str)) for k, v in candidates.items())
            or (reference is not None and not isinstance(reference, str))):
        raise SvRequestError("invalid frozen allele competition")
    if len(candidates) + 1 > policy.max_candidates or sum(len(v or '') for v in [reference, *candidates.values()]) > DEFAULT_LIMITS.max_input_bases:
        raise SvRequestError("allele target exceeds sequence/candidate budget")
    if max([target_end - ref, *(len(v or '') for v in candidates.values())]) > policy.max_sequence_bp:
        raise SvRequestError("allele target exceeds sequence budget")
    contexts = specification.get("chemistry_by_name") or {}
    if not isinstance(contexts, dict):
        raise SvRequestError("chemistry_by_name must be an object")
    for value in contexts.values():
        if not isinstance(value, dict) or set(value) - {"chemistry", "provenance", "conversion_rate", "substitution_rate"}:
            raise SvRequestError("invalid molecule chemistry context")
        if ("chemistry" not in value or not isinstance(value.get("provenance"), str) or not value["provenance"]
                or value["chemistry"] not in {"none", "CT", "GA", "unknown"}
                or not isinstance(value.get("conversion_rate", .9), (int, float))
                or not 0 <= value.get("conversion_rate", .9) <= 1
                or not isinstance(value.get("substitution_rate", .01), (int, float))
                or not 0 <= value.get("substitution_rate", .01) < 1):
            raise SvRequestError("invalid molecule chemistry context")
    diagnostic_start = specification.get("diagnostic_start", ref)
    diagnostic_end = specification.get("diagnostic_end", target_end)
    if (type(diagnostic_start) is not int or type(diagnostic_end) is not int
            or not 0 <= diagnostic_start <= ref <= target_end <= diagnostic_end
            or diagnostic_end - diagnostic_start > policy.max_sequence_bp):
        raise SvRequestError("invalid diagnostic window")
    if reference is not None and len(reference) != diagnostic_end - diagnostic_start:
        raise SvRequestError("reference sequence must cover the full diagnostic window")
    competition_complete = specification.get("competition_complete") is True
    snapshot = {"target_id": target, "revision": revision, "reference": reference,
                "target_type": "provisional_sequence",
                "candidates": candidates, "competition_complete": competition_complete,
                "span": [ref, target_end], "diagnostic_window": [diagnostic_start, diagnostic_end],
                "chrom": chrom, "analysis_scope": "native_only"}
    # Identity also includes the frozen qualified cohort. No sequence result is
    # cached under this ID; changed BAM/reference cache revisions cannot replay it.
    request_id = content_id("enrichment-request:v3", [snapshot, contexts, asdict(policy), envelope['scope'], envelope['policy'],
                                              sorted(envelope['calls_by_molecule'])])
    calls = {m: {"call": asdict(Call(reasons=("diagnostic_sequence_not_loaded",))), "alignments": [],
                 "representations": [], "complete": False}
             for m in envelope["calls_by_molecule"]}
    results, seen, total_bases, count = {}, set(), 0, 0
    interrupted, current_molecule = set(), None
    reasons = set()
    budget = LikelihoodBudget(policy)
    fetched = records if records is not None else _bam_records(state, dataset_id, chrom, max(0, diagnostic_start - 1), diagnostic_end + 1,
                                                              with_handle=True, checkpoint_fn=budget.check)
    try:
        for read, file_chrom, *locator in fetched:
            budget.check()
            if not include_duplicates and read.is_duplicate:
                continue
            molecule = MoleculeId("legacy_merged_dataset", dataset_id, read.query_name)
            if molecule.key not in calls:
                continue
            lineage = content_id("native-alignment:v1", [dataset_id, read.to_string()])
            if lineage in seen:
                continue
            applicable = (read.reference_end is not None and read.reference_start < diagnostic_end + 1
                          and read.reference_end > diagnostic_start - 1)
            current_molecule = molecule.key if applicable else None
            if count >= DEFAULT_LIMITS.max_inputs:
                reasons.add("diagnostic_record_cap")
                if applicable:
                    interrupted.add(molecule.key)
                break
            seen.add(lineage)
            count += 1
            obs = observe_interval(read, diagnostic_start, diagnostic_end, max_bases=policy.max_sequence_bp)
            total_bases += len(obs["sequence"] or '')
            if total_bases > DEFAULT_LIMITS.max_input_bases:
                reasons.add("diagnostic_input_bases_cap")
                if applicable:
                    interrupted.add(molecule.key)
                break
            try:
                # Explicit molecule context, then the record's own st tag, then the
                # dataset-level default ("*"), else unknown chemistry.
                raw = contexts.get(read.query_name)
                if raw is None and read.has_tag("st") and read.get_tag("st") in ("CT", "GA"):
                    raw = {"chemistry": read.get_tag("st"), "provenance": "bam_st_tag"}
                context = DafContext(**(raw or contexts.get("*") or {"chemistry": "unknown", "provenance": "unavailable"}))
            except TypeError as exc:
                raise SvRequestError("invalid molecule chemistry context") from exc
            # Context chemistry is canonical; BAM reverse orientation needs its
            # transition matrix complemented exactly once, never a CT/GA rename.
            # An st-tag chemistry describes the stored SEQ, which observe_interval returns as is (never complemented);
            # an explicit molecule-frame context is complemented for a reverse-mapped record.
            from .alleles import stored_frame_chemistry
            reverse = False if stored_frame_chemistry(context) else bool(read.is_reverse)
            context = replace(context, reverse_complemented=reverse, base_qualities=obs["qualities"])
            geometry = envelope['calls_by_molecule'][molecule.key].get('geometry_evidence') or {}
            conditional = compete(obs["sequence"], {**candidates, "reference": reference}, target_id=target,
                                  complete=obs["complete"] and competition_complete, context=context, policy=policy, budget=budget,
                                  geometry_level=geometry.get('level') or 'confirmed')
            interval = obs["query_interval"]
            witness = witness_id(molecule, lineage, *(interval or (0, 0)), kind="diagnostic_path")
            raw = conditional["call"]
            missed = applicable and _missed_competing_edit(read, diagnostic_start, diagnostic_end,
                                                           reference, candidates[target], budget.check)
            if not applicable:
                raw = asdict(Call('unavailable', reasons=('alignment_outside_diagnostic_locus',)))
                conditional['call'] = raw
            elif ((raw['assignment'] == 'reference' and
                   (missed or envelope['calls_by_molecule'][molecule.key].get('geometry_group') == 0))
                  or (raw['assignment'] == 'unknown' and not obs['complete'] and missed)):
                # A normalized repeat anchor may lie away from the raw CIGAR
                # operation. Require a larger explicit diagnostic window rather
                # than turning that missed operation into a reference vote.
                raw = asdict(Call('ambiguous', 'ambiguous', reasons=('diagnostic_window_misses_geometry',)))
                conditional['call'] = raw
            call = Call(raw["assignment"], raw["level"], raw["allele_id"], raw["method"], tuple(raw["reasons"]),
                        (witness,), (lineage,), ({"ref_start": diagnostic_start, "ref_end": diagnostic_end, "complete": obs["complete"]},))
            if applicable:
                results.setdefault(molecule.key, []).append(Representation(lineage, "native", call))
            calls[molecule.key]["alignments"].append({"alignment_id": lineage, "witness_id": witness,
                "query_interval": interval, "coverage_complete": obs["complete"], "locus_applicable": applicable,
                "read_bases": (obs["sequence"] or '')[:60], "read_bases_length": len(obs["sequence"] or ''),
                "competition": conditional})
            if conditional.get("resource"):
                reasons.add(conditional["resource"]["reason"])
                if applicable:
                    interrupted.add(molecule.key)
                break
            current_molecule = None
    except ResourceResult as exc:
        reasons.add(exc.reason)
        if current_molecule is not None:
            interrupted.add(current_molecule)
    finally:
        if records is None and hasattr(fetched, 'close'):
            fetched.close()
    for molecule, representations in results.items():
        if molecule in interrupted:
            representations.append(Representation("unexplored_diagnostics", "native", Call(reasons=tuple(sorted(reasons)))))
        calls[molecule].update(reconcile_representations(representations, scope="native_only"))
    for molecule in calls.keys() - results.keys():
        if reasons:
            calls[molecule]['call'] = asdict(Call(reasons=tuple(sorted(reasons | {'diagnostic_sequence_not_loaded'}))))
    counts = {assignment: sum(c["call"]["assignment"] == assignment for c in calls.values())
              for assignment in ("target", "reference", "other_allele", "ambiguous", "unknown")}
    counts_by_level = {assignment: {level: sum(c['call']['assignment'] == assignment and c['call']['level'] == level for c in calls.values())
                                   for level in ('confirmed', 'putative', 'ambiguous', 'conflicting', None)}
                       for assignment in counts}
    enrichment_id = content_id('enrichment:v3', [request_id, sorted(seen), sorted(reasons),
                                               {m: c['call'] for m, c in calls.items()}])
    result = {"enrichment_id": enrichment_id, "snapshot": snapshot, "calls_by_molecule": calls,
              "request_id": request_id, "complete": not reasons and competition_complete and counts['unknown'] == 0,
              "counts": counts, "counts_by_level": counts_by_level, "search_complete": not reasons, "reasons": sorted(reasons),
              "policy": asdict(policy), "records_enriched": count, "observed_bases": total_bases,
              "likelihood_cells": budget.cells, "identity_assumption": "legacy_merged_dataset"}
    if len(json.dumps(result).encode()) > DEFAULT_LIMITS.max_response_bytes:
        return {"enrichment_id": enrichment_id, "complete": False, "reasons": ["response_bytes_cap"],
                "calls_by_molecule": {}, "snapshot": snapshot}
    return result
