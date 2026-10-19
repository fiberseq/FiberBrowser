"""Bounded inspection and alternate-local annotations for the shared workspace.

Native geometry retains the independent SV producer and its saved policy. Map
calls use the separately validated projection producer. Neither source badge
nor an annotation block supplies an allele vote.
"""
from __future__ import annotations

import copy
from dataclasses import asdict
import hashlib
import json
import time

from services.background_work import checkpoint
from services.reconstruction_budget import ResourceResult, RESERVATIONS, DEFAULT_LIMITS
from .model import SCHEMA_VERSION
from .calls import MoleculeId
from .call_policy import molecule_group
from .projected_service import projected_analysis, validate_target
from .projection import ProjectionPolicy

LAYOUT_VERSION = "boundary-aligned:v1"
MAX_ROWS = 500
MAX_BYTES = 16 * 1024 * 1024
from services.byte_cache import shared_cache
_BLOCK_CACHE = shared_cache('differences-alternate', default_bytes=32*1024*1024)


def expandable_alt_block(ref_bp, alt_bp):
    return 50 <= alt_bp <= 50_000 and (ref_bp == 0 or alt_bp > ref_bp and
        (alt_bp-ref_bp >= 50 or ref_bp <= min(50, .25*alt_bp)))


def inspect(state, dataset, *, chrom, start, end, target, policy=None,
            include_duplicates=False, include_putative=True, include_conflicting=False,
            include_ambiguous=False, analysis_scope=None, native_dataset_id=None):
    """One frozen target, policy, molecule cohort and qualified row membership."""
    from services.background_work import dataset_identity
    from .identity import content_id
    revision = _workspace_revision(state, [dataset.id, *([native_dataset_id] if native_dataset_id else [])])
    policy = dict(policy or {})
    if "search" in policy:
        from .policy import SearchPolicy
        policy["search"] = SearchPolicy(**policy["search"])
    projection_policy = ProjectionPolicy(**policy)
    target = validate_target(target, chrom, start, end, projection_policy)
    evidence_policy = dict(include_duplicates=include_duplicates, include_putative=include_putative,
                           include_conflicting=include_conflicting, include_ambiguous=include_ambiguous)
    if dataset.data_type == "bam_livelift":
        result = projected_analysis(state, dataset, chrom=chrom, start=start, end=end, target=target,
            feature="split", policy=projection_policy, include_duplicates=include_duplicates,
            analysis_scope=analysis_scope or "lifted_only", native_dataset_id=native_dataset_id,
            contexts=target.get("chemistry_by_name"), evidence_policy=evidence_policy)
        result["evidence_policy"] = evidence_policy
        result["scope"]["data_revision"] = revision
        return result
    if dataset.data_type != "bam" or analysis_scope not in (None, "native_only"):
        raise ValueError("native inspection requires a native BAM and native_only scope")
    from services.sv_endpoint import sv_split_payload
    ref_bp, alt_bp = target["ref_end"]-target["ref_start"], target["alt_bp"]
    if ref_bp and alt_bp:
        result = _native_both_span_calls(state, dataset, chrom=chrom, start=start, end=end, target=target,
            policy=projection_policy, evidence_policy=evidence_policy)
        result["scope"]["data_revision"] = revision
        return result
    if max(ref_bp, alt_bp) < 10:
        raise ValueError("native differences require at least 10 bp of geometry")
    # Both-span targets are passed intact, including insertion-dominant replacements.
    t, length = ("I", alt_bp) if alt_bp >= ref_bp else ("D", ref_bp)
    native = sv_split_payload(state, dataset_id=dataset.id, chrom=chrom, start=start, end=end,
        t=t, ref=target["ref_start"], length=length, target_end=target["ref_end"],
        payload_version=2, **evidence_policy)
    envelope = native["differences"]
    calls = envelope["calls_by_molecule"]
    if target["target_type"] == "exact":
        # The diagnostic producer is selected explicitly, leaving geometry intact.
        from .enrichment import enrich_native
        enriched = enrich_native(state, envelope, dataset_id=dataset.id, chrom=chrom,
            ref=target["ref_start"], target_end=target["ref_end"],
            specification={**target, "reference": target.get("candidates", {}).get("reference"),
                "candidates": {k: v for k, v in target.get("candidates", {}).items() if k != "reference"}},
            include_duplicates=include_duplicates)
        calls = enriched["calls_by_molecule"]
    counts=native["counts"]
    if target["target_type"]=="exact":
        counts=[0,0,0]
        for value in calls.values():
            call=value["call"]
            level=call["level"]
            allowed=level=="confirmed" or level=="putative" and include_putative or level=="conflicting" and include_conflicting or level=="ambiguous" and include_ambiguous
            group=0 if call["assignment"]=="target" and allowed else 1 if call["assignment"]=="reference" else 2
            counts[group]+=1
    return dict(schema_version=SCHEMA_VERSION, analysis_scope="native_only", membership=envelope["membership"],
        evidence_policy=evidence_policy, policy=envelope["policy"], scope={**envelope["scope"], "data_revision": revision},
        identity_assumption=envelope["identity_assumption"], targets=[dict(target=target,
            calls_by_molecule=calls, counts=counts, geometry_counts=envelope["geometry_counts"],
            sequence_unresolved_count=len(calls) if target["target_type"]=="geometry" else sum(c["call"]["assignment"] not in {"target","reference","other_allele"} for c in calls.values()))])


def _query_window(read, target):
    """Observed query slice; retained replacement bridges remain in this slice."""
    from services.sv_events import extract_sv_events
    from .projection import geometry_matches
    r, a = target["ref_end"]-target["ref_start"], target["alt_bp"]
    for event in (extract_sv_events(read, min_len=10, include_seq=False) or []):
        if event["t"] not in {"I", "D"}:
            continue
        geometry = dict(ref_start=event["ref"], ref_end=event.get("ref_end", event["ref"] + (event["len"] if event["t"] == "D" else 0)),
                        alt_bp=event.get("alt_len", event["len"] if event["t"] == "I" else 0))
        if geometry_matches(geometry, target, ProjectionPolicy()):
            lo, hi = event["q"], event.get("q_end", event["q"]+geometry["alt_bp"])
            if hi > lo or target["alt_bp"] == 0 and hi == lo:
                return lo, hi, 0, hi-lo, "full", geometry["ref_start"], geometry["ref_end"], None
    if target["ref_start"] == target["ref_end"] and read.has_tag("SA"):
        from services.sv_endpoint import _compact_record
        from services.sv_events import carrier_evidence
        from services.insertion_lens import _carrier_plan
        evidence=carrier_evidence(_compact_record(read,read.reference_name,10),"I",target["ref_start"],target["alt_bp"],read.reference_name)
        if evidence and evidence.get("kind")=="sa" and evidence.get("level")=="confirmed":
            plan=_carrier_plan(read,evidence,target["alt_bp"])
            if plan["kind"]=="cigar":
                return plan["q"],plan["q"]+plan["len"],0,plan["len"],"full",plan["ref"],plan["ref_end"],None
    # Soft clips retain only the observed prefix/suffix at their own bp offsets.
    q, ref = 0, read.reference_start
    candidates = []
    for op, n in read.cigartuples or ():
        if op == 4 and n and a > 0 and abs(ref-target["ref_end"]) <= max(20, .05*a):
            right = q > 0
            size = min(n, a)
            lo = q if right else q+n-size
            candidates.append((lo, lo+size, 0 if right else a-size, a, "partial", ref, ref, "start" if right else "end"))
        if op in (0, 1, 4, 7, 8):
            q += n
        if op in (0, 2, 3, 7, 8):
            ref += n
    return candidates[0] if len(candidates) == 1 else None


def _query_annotations(read, bam, path, q0, q1, layers, layer_options=None):
    """Decode once on the observed SEQ axis; the original tag frames survive.

    This transient copy is local to the decoder. It never supplies reference
    coverage, target evidence or a stored alignment.
    """
    from services.compact_read_loader import _build_compact_reads_from_bam_region
    from services.insertion_lens import _OneReadHandle
    source = copy.copy(read)
    hard_left = read.cigartuples[0][1] if read.cigartuples[0][0] == 5 else 0
    hard_right = read.cigartuples[-1][1] if read.cigartuples[-1][0] == 5 else 0
    source.reference_start = 0
    source.cigartuples = ([(5, hard_left)] if hard_left else []) + [(0, read.query_length)] + ([(5, hard_right)] if hard_right else [])
    for tag in ("MD", "SA"):
        if source.has_tag(tag):
            source.set_tag(tag, None)
    options=dict(layer_options or {})
    allowed={"min_fp_quality","ml_threshold","infer_legacy_layers","legacy_nuc_min_size"}
    if set(options)-allowed:
        raise ValueError("unsupported alternate annotation option")
    if any(not isinstance(v,(int,float,bool)) for v in options.values()):
        raise ValueError("invalid alternate annotation option")
    rows = _build_compact_reads_from_bam_region(path, read.reference_name, q0, q1,
        bam_handle_getter=lambda _: _OneReadHandle(bam, source), spanning_only=False,
        include_supplementary=True, include_duplicates=True, hide_terminal_gaps=False,
        include_layers=True, requested_layers=layers, include_layer_qualities=True,
        include_methylation=True, **options)
    from services.insertion_lens import _IDENTITY_FIELDS
    return {k:v for k,v in rows[0].items() if k not in _IDENTITY_FIELDS} if rows else dict(intervals=[])


def _alternate_blocks(state, dataset, *, chrom, start, end, target, row_ids=None, layers=None,
                     include_duplicates=False, inspection=False, layer_options=None):
    """Lazy native enrichment, bounded independently of display/scan caches."""
    if dataset.data_type != "bam":
        raise ValueError("native alternate blocks require a native BAM")
    target = validate_target(target, chrom, start, end, ProjectionPolicy())
    if not inspection and not expandable_alt_block(target["ref_end"]-target["ref_start"], target["alt_bp"]):
        raise ResourceResult("unavailable", "alternate_block_geometry")
    if row_ids is not None and len(row_ids) > MAX_ROWS:
        raise ResourceResult("budget_exceeded", "alternate_block_rows")
    selected = set(row_ids) if row_ids is not None else None
    from services.sv_endpoint import _bam_records
    blocks, seen, scanned, total_bytes = [], set(), 0, 0
    deadline = time.monotonic()+30
    # Covers bounded decoded tags, output and transient query arrays before I/O.
    reserved = 128 * 1024 * 1024
    def check():
        checkpoint()
        if time.monotonic() > deadline:
            raise ResourceResult("budget_exceeded", "alternate_block_deadline")
    RESERVATIONS.acquire(reserved, False, deadline, check)
    try:
        for read, _, path, bam in _bam_records(state, dataset.id, chrom, start, end, with_handle=True, checkpoint_fn=check):
            check()
            scanned += 1
            if scanned > 20_000:
                raise ResourceResult("budget_exceeded", "alternate_block_scan")
            if selected is not None and read.query_name not in selected:
                continue
            if read.is_duplicate and not include_duplicates:
                continue
            if read.query_length is None or read.query_length > DEFAULT_LIMITS.max_input_bases:
                raise ResourceResult("budget_exceeded", "alternate_block_record_bases")
            sam = read.to_string().encode()
            if len(sam) > MAX_BYTES:
                raise ResourceResult("budget_exceeded", "alternate_block_record_bytes")
            record = hashlib.sha256(sam).hexdigest()
            key = (path, record)
            if key in seen:
                continue
            seen.add(key)
            window = _observation_window(read, target) if inspection else _query_window(read, target)
            if window is None:
                continue
            q0, q1, offset, length, coverage = window[:5]
            if length > 50_000:
                raise ResourceResult("budget_exceeded", "alternate_block_observed_length")
            if len(blocks) >= MAX_ROWS:
                raise ResourceResult("budget_exceeded", "alternate_block_rows")
            data = _query_annotations(read, bam, path, q0, q1, layers, layer_options) if q1 > q0 else dict(intervals=[])
            block = {k: data[k] for k in ("intervals", "layers", "qualities", "fire", "methyl_m6a", "methyl_m5c", "deam", "possible_deam_ct", "possible_deam_ga") if k in data}
            # Partial end observations are boundary-aligned; no proportional stretching.
            _transform_annotations(block, offset=offset)
            sequence = (read.query_sequence or "")[q0:q1]
            block.update(source="reads", column_id=target["target_id"], target_revision=target["revision"],
                record_id=record, row_id=read.query_name,
                molecule_id=MoleculeId('legacy_merged_dataset',dataset.id,read.query_name).key,
                kind="replacement" if target["ref_end"] > target["ref_start"] and target["alt_bp"] else "deletion" if target["ref_end"] > target["ref_start"] else "insertion",
                t_start=target["ref_start"], t_end=target["ref_end"], ref_bp=target["ref_end"]-target["ref_start"], alt_bp=target["alt_bp"],
                pos=target["ref_end"], observed_ref_start=window[5], observed_ref_end=window[6], hap_label="", src=[read.reference_name, q0, q1], seq_q=[q0, q1],
                length=length, mol_bp=q1-q0, orientation="+", read_orientation="-" if read.is_reverse else "+",
                covered=[offset, offset+q1-q0], coverage=coverage,
                observation_role=window[8] if len(window)>8 else "alternate",
                read_bases=sequence[:60], read_bases_length=len(sequence),
                layout_version=LAYOUT_VERSION, unaligned_interior=True)
            from .identity import content_id
            call_groups={"intervals":block.get("intervals",[]),**{"layer:"+name:layer.get("intervals",[]) for name,layer in block.get("layers",{}).items()}}
            block["calls"],block["call_parts"],block["straddles"]={},{},[]
            for name,intervals in call_groups.items():
                layer=block.get("layers",{}).get(name.removeprefix("layer:"),{})
                originals=layer.get("source_intervals",intervals)
                ids,parts=[],[]
                for i,(a,b,*tail) in enumerate(intervals):
                    original=originals[i] if i<len(originals) else [a,b,*tail]
                    ids.append(content_id("observed-call:v1",[record,name,original[0]+q0-offset,original[1]+q0-offset,*original[2:]]))
                    parts.append([a,b])
                    if original[0] < block["covered"][0] or original[1] > block["covered"][1]:
                        block["straddles"].append(dict(call_id=ids[-1],layer=name,start=original[0],end=original[1]))
                block["calls"][name],block["call_parts"][name]=ids,parts
            total_bytes += len(json.dumps(block).encode())
            if total_bytes > MAX_BYTES:
                raise ResourceResult("budget_exceeded", "alternate_block_response_bytes")
            blocks.append(block)
        return dict(schema_version=SCHEMA_VERSION, target=target, blocks=blocks, complete=True,
                    layout_version=LAYOUT_VERSION)
    finally:
        RESERVATIONS.release(reserved, False)


def alternate_blocks(state, dataset, **kwargs):
    from services.background_work import dataset_identity
    from .identity import content_id
    from services.signal_evidence import signal_filter_key
    # Separate from geometry, display, sequence and reconstruction caches.
    key=("alternate-blocks:v1", dataset_identity(state,[dataset.id]), signal_filter_key(state),
         content_id("alternate-request",kwargs))
    cached=_BLOCK_CACHE.get(key)
    if cached is not None:
        checkpoint()
        return copy.deepcopy(cached)
    value=_alternate_blocks(state,dataset,**kwargs)
    if value.get("complete"):
        _BLOCK_CACHE[key]=copy.deepcopy(value)
    return value


def sequence(state, dataset, *, chrom, start, end, target, row_ids=None, layers=None,
             include_duplicates=False, record_id=None, offset=0, limit=1000, layer_options=None):
    """Explicit paged observed sequence from a full, identified native record."""
    if dataset.data_type != "bam" or not row_ids or len(row_ids) != 1 or not record_id:
        raise ValueError("observed sequence needs one native row and its record identity")
    target = validate_target(target, chrom, start, end, ProjectionPolicy())
    if not 0 <= offset or not 1 <= limit <= 50_000:
        raise ValueError("bounded sequence page required")
    from services.sv_endpoint import _bam_records
    for n, (read, _, _, _) in enumerate(_bam_records(state, dataset.id, chrom, start, end, with_handle=True, checkpoint_fn=checkpoint)):
        checkpoint()
        if n >= 20_000:
            raise ResourceResult("budget_exceeded", "sequence_scan")
        if read.query_name != row_ids[0] or hashlib.sha256(read.to_string().encode()).hexdigest() != record_id:
            continue
        if read.is_duplicate and not include_duplicates:
            continue
        window = _observation_window(read, target)
        if window is None or window[4] != "full" or window[1]-window[0] > 50_000:
            raise ResourceResult("unavailable", "full_observed_alternate_unavailable")
        observed = (read.query_sequence or "")[window[0]:window[1]]
        if len(observed) != window[1]-window[0]:
            raise ResourceResult("unavailable", "observed_sequence_unavailable")
        return dict(source="reads", provenance="one observed read", target_id=target["target_id"],
            observation_role=window[8] if len(window)>8 else "alternate",
            revision=target["revision"], record_id=record_id, sequence=observed[offset:offset+limit],
            offset=offset, length=len(observed), complete=offset == 0 and limit >= len(observed),
            next_offset=min(len(observed), offset+limit) if offset+limit < len(observed) else None)
    raise ResourceResult("unavailable", "record_not_in_scope")


def _native_both_span_calls(state, dataset, *, chrom, start, end, target, policy, evidence_policy):
    """Use explicit ref and alt spans for replacements, never a pure-I/D proxy."""
    from .projected_service import native_bundles, native_call, _public_projection
    from .projection import ProjectionBudget
    from .likelihood import LikelihoodBudget, LikelihoodPolicy
    from .calls import MembershipIndex
    from .projected_service import chemistry_context
    budget = ProjectionBudget(policy)
    reserved = 128*1024*1024
    RESERVATIONS.acquire(reserved, False, budget.deadline, budget.check)
    try:
        bundles, reasons, interrupted = native_bundles(state, dataset.id, chrom, start, end,
            include_sequence=target["target_type"] == "exact", include_duplicates=evidence_policy["include_duplicates"], budget=budget)
        index, calls, counts, geometry_counts = MembershipIndex(), {}, [0, 0, 0], [0, 0, 0]
        likelihood_budget = LikelihoodBudget(LikelihoodPolicy())
        for key, records in bundles.items():
            budget.check()
            detail = native_call(records, target, policy=policy, budget=budget, context=chemistry_context(target.get("chemistry_by_name"), key, bundles), likelihood_budget=likelihood_budget)
            call = detail["call"]
            if key in interrupted:
                call = dict(assignment="unknown", level=None, method="native_cigar", reasons=reasons, witness_ids=[])
            group = molecule_group(dict(call=call), "exact", evidence_policy)
            counts[group] += 1
            geometry = detail["geometry_call"]
            geometry_group = molecule_group(dict(call=geometry), "geometry", evidence_policy)
            if key in interrupted:geometry_group=2
            geometry_counts[geometry_group]+=1
            calls[key] = dict(call=call, complete=detail["complete"] and key not in interrupted,
                representations=[dict(kind="native", call=call)], geometry_group=geometry_group, geometry_evidence=geometry,
                native=_public_projection(detail), exact_assignment="unknown" if target["target_type"] == "geometry" else call["assignment"])
            for record in records:
                index.add(dataset.id, record.record_id, record.molecule)
        for name, molecule in index.payload()["legacy_aliases"].get(dataset.id, {}).items():
            index.rows[dataset.id][name] = molecule
        return dict(schema_version=SCHEMA_VERSION, analysis_scope="native_only", membership=index.payload(),
            evidence_policy=evidence_policy, policy=asdict(policy), scope=dict(cohort="loaded", search_complete=not reasons, reasons=reasons),
            targets=[dict(target=target, calls_by_molecule=calls, counts=counts, geometry_counts=geometry_counts,
                sequence_unresolved_count=sum(c["exact_assignment"] == "unknown" for c in calls.values()))])
    finally:
        RESERVATIONS.release(reserved, False)


def _carrier_molecules(result):
    target = result["targets"][0]
    calls = target["calls_by_molecule"]
    policy = result["evidence_policy"]
    return {key for key, value in calls.items()
            if molecule_group(value, target["target"]["target_type"], policy) == 0}


def _carrier_keys(result,dataset_id):
    keys=_carrier_molecules(result)
    # Aliases are dataset-qualified and only emitted when unambiguous.
    return {name: molecule for name, molecule in result["membership"]["legacy_aliases"].get(dataset_id, {}).items() if molecule in keys}


def _source_query_window(read, a, b):
    r, q, left, right = read.reference_start, 0, None, None
    for op, n in read.cigartuples or ():
        if op in (0, 7, 8):
            if r <= a-1 < r+n:
                left = q+a-r
            if r <= b < r+n:
                right = q+b-r
            r, q = r+n, q+n
        elif op in (1, 4):
            q += n
        elif op in (2, 3):
            r += n
    return (left, right) if left is not None and right is not None and left <= right else None


def lens(state, dataset, *, chrom, start, end, target, frozen_calls=None, include_sequences=False, consensus=True, **options):
    """Detailed workspace from a frozen call snapshot, including budgeted consensus.

    No display filter or global duplicate/phase setting reclassifies this cohort.
    Every input is an observed full alternate from one selected representation;
    at most one complete input per molecule reaches reconstruction.
    """
    from services.insertion_consensus import reconstruct_lens, METHOD_LABELS
    if dataset.data_type == "bam_livelift":
        from services.lift.capability import require
        require(dataset,"difference_lens")
    from services.insertion_lens import _is_daf_dataset
    if not frozen_calls or frozen_calls.get("status") or not frozen_calls.get("targets"):
        raise ValueError("lens requires a frozen call snapshot")
    # Treat caller snapshots as cohort intent, then independently verify against
    # the loaded dataset/target/policy before decoding or reconstruction.
    from services.background_work import dataset_identity
    from .identity import content_id
    dataset_ids = list(frozen_calls.get("membership", {}).get("rows", {}))
    if frozen_calls.get("scope", {}).get("data_revision") != _workspace_revision(state, dataset_ids):
        raise ResourceResult("unavailable", "stale_call_snapshot")
    if len(json.dumps(frozen_calls).encode()) > MAX_BYTES:
        raise ResourceResult("budget_exceeded", "lens_snapshot_bytes")
    selected = frozen_calls["targets"][0]
    if selected["target"] != target or dataset.id not in frozen_calls["membership"]["rows"]:
        raise ValueError("lens snapshot target/dataset mismatch")
    aliases = _carrier_keys(frozen_calls, dataset.id)
    expected_carriers=_carrier_molecules(frozen_calls)
    if len(aliases) > MAX_ROWS:
        raise ResourceResult("budget_exceeded", "lens_cohort_rows")
    inputs, total_bases = {}, 0
    deadline = time.monotonic()+30
    def accept(name, observed, record, bam, path, q0, q1, reverse=False, partial=None):
        nonlocal total_bases
        checkpoint()
        if time.monotonic() > deadline:
            raise ResourceResult("budget_exceeded", "lens_deadline")
        molecule = aliases.get(name)
        if molecule is None or not observed:
            return
        existing=inputs.get(molecule)
        if existing and (not existing[0].get("partial") or partial):return
        if existing:total_bases-=len(existing[1])
        if len(observed) > 50_000 or total_bases+len(observed) > DEFAULT_LIMITS.max_input_bases:
            raise ResourceResult("budget_exceeded", "lens_input_bases")
        if record.query_length is None or record.query_length > DEFAULT_LIMITS.max_input_bases:
            raise ResourceResult("budget_exceeded", "lens_record_bases")
        if record.is_duplicate and not frozen_calls["evidence_policy"]["include_duplicates"]:
            return
        data = _query_annotations(record, bam, path, q0, q1, None)
        n = len(observed)
        if reverse:
            _transform_annotations(data, reverse_length=n)
        total_bases += n
        level = selected["calls_by_molecule"][molecule]["call"]["level"]
        inputs[molecule] = (dict(id=name, strand="-" if record.is_reverse != reverse else "+",
            **(dict(partial=partial,kind="clip") if partial else dict(kind="cigar")), evidence_level=level, ref=target["ref_start"], ref_end=target["ref_end"], q=q0, len=n, read=data), observed, (record, q0, q1-q0, observed), reverse)
    reserved = 128*1024*1024
    RESERVATIONS.acquire(reserved, False, deadline, checkpoint)
    try:
        if dataset.data_type == "bam":
            from services.sv_endpoint import _bam_records
            for n, (record, _, path, bam) in enumerate(_bam_records(state, dataset.id, chrom, start, end, with_handle=True, checkpoint_fn=checkpoint)):
                if n >= 20_000:
                    raise ResourceResult("budget_exceeded", "lens_scan")
                if record.query_name not in aliases:
                    continue
                w = _query_window(record, target)
                if w is not None:
                    accept(record.query_name, (record.query_sequence or "")[w[0]:w[1]], record, bam, path, w[0], w[1], partial=w[7] if w[4]=="partial" else None)
        elif dataset.data_type == "bam_livelift":
            from services.lift.capability import require
            from services.lift.differences import difference_reads, revcomp
            require(dataset, "difference_lens")
            def observe(item, observed, record, bam, path, span):
                if item["id"] not in aliases or not item.get("carries_insertion"):
                    return
                from .projection import geometry_matches
                if not geometry_matches(dict(ref_start=span["t_start"], ref_end=span["t_end"], alt_bp=span["alt_bp"]), target, ProjectionPolicy()):
                    return
                window = _source_query_window(record, span["src"]["start"], span["src"]["end"])
                if not window:
                    return
                q0, q1 = window
                raw = (record.query_sequence or "")[q0:q1]
                reverse = span["strand"] == "-"
                if (revcomp(raw) if reverse else raw) != observed:
                    return
                accept(item["id"], observed, record, bam, path, q0, q1, reverse)
            difference_reads(state, dataset, chrom, target["ref_start"], target["ref_end"],
                item_id=target["target_id"], observation_sink=observe)
        else:
            raise ValueError("a BAM-backed source is required")
        # Match the independent native lens order; stable read inputs cannot
        # change numerical backbones merely because a row or hash sorts first.
        ordered_inputs=sorted(inputs.items(),key=lambda item:(0 if not item[1][0].get("partial") else 1 if item[1][0]["partial"]=="start" else 2,
            item[1][0]["len"],item[1][0]["id"],item[0]))
        entries = [v[0] for _, v in ordered_inputs]
        sequences = [v[1] for _, v in ordered_inputs]
        counts = selected["counts"]
        levels={level:sum(selected["calls_by_molecule"][key]["call"]["level"]==level for key in expected_carriers)
                for level in ("confirmed","putative","conflicting","ambiguous")}
        payload = dict(success=True, dataset_id=dataset.id, chrom=chrom, flank=0,
            site=dict(pos=target["ref_start"], tolerance=0, len_min=target["alt_bp"], len_max=target["alt_bp"]),
            cluster=dict(ref=target["ref_start"], len=target["alt_bp"], ref_len=target["ref_end"]-target["ref_start"],
                alt_len=max(map(len, sequences), default=target["alt_bp"]), len_lo=min(map(len, sequences), default=target["alt_bp"]),
                len_hi=max(map(len, sequences), default=target["alt_bp"]), carriers=levels["confirmed"], reference=counts[1],
                **levels,cigar=sum(e.get("kind")=="cigar" for e in entries),clipped=sum(e.get("kind")=="clip" for e in entries),evidence_total=len(expected_carriers)),
            carriers=entries, reference=[], excluded=dict(other_insert=0, not_informative=counts[2]),
            truncated=dict(carriers=len(expected_carriers)-len(entries), reference=counts[1]),
            difference_scope=dict(target=target, evidence_policy=frozen_calls["evidence_policy"],
                analysis_scope=frozen_calls["analysis_scope"], complete=len(entries)==len(expected_carriers),
                reason=None if len(entries)==len(expected_carriers) else "full_observed_alternate_unavailable"))
        if include_sequences:
            for entry, value in zip(entries, sequences):
                entry["seq"] = value
        if sequences and consensus and any(not e.get("partial") for e in entries):
            # Reversed-map DAF input needs a complemented chemistry kernel;
            # retain an explicit labelled majority fallback until that gate.
            daf = _is_daf_dataset(dataset)
            reversed_map = any(v[3] for v in inputs.values())
            try:
                full=[seq for entry,seq in zip(entries,sequences) if not entry.get("partial")]
                partials=[(seq,entry["partial"]) for entry,seq in zip(entries,sequences) if entry.get("partial")]
                result = reconstruct_lens(full, full, partials,
                    records=[v[2] for _,v in ordered_inputs if not v[0].get("partial")], daf=daf, daf_compatible=not reversed_map)
                cons = result["full"]
                for entry, knots in zip([e for e in entries if not e.get("partial")], cons["reads"]):
                    entry.update(knots=knots["knots"], identity=knots["identity"])
                for entry,knots in zip([e for e in entries if e.get("partial")],result["partials"]):
                    entry.update(knots=knots["knots"],identity=knots["identity"])
                payload["consensus"] = dict(seq=cons["seq"], length=len(cons["seq"]), n_reads=len(full), seconds=0,
                    method=result["method"], method_label=METHOD_LABELS[result["method"]], fallback=result["fallback"],
                    alignment_algorithms=result["alignment_algorithms"], source="read_consensus",
                    target_revision=target["revision"], cohort_scope=frozen_calls["analysis_scope"])
            except ResourceResult as exc:
                payload["consensus_resource"] = exc.payload()
        if len(json.dumps(payload).encode()) > MAX_BYTES:
            raise ResourceResult("budget_exceeded", "lens_response_bytes")
        return payload
    finally:
        RESERVATIONS.release(reserved, False)


def _workspace_revision(state, dataset_ids):
    from services.background_work import dataset_identity
    from services.signal_evidence import signal_filter_key
    from .identity import content_id
    return content_id("workspace-data-revision:v1", [dataset_identity(state,dataset_ids),signal_filter_key(state)])


def _observation_window(read,target):
    window=_query_window(read,target)
    if window is not None:return window
    window=_source_query_window(read,target["ref_start"],target["ref_end"])
    if window is None:return None
    a,b=window
    return a,b,0,b-a,"full",target["ref_start"],target["ref_end"],None,"reference"


def observations(state,dataset,**kwargs):
    if max(kwargs["target"]["ref_end"]-kwargs["target"]["ref_start"],kwargs["target"]["alt_bp"])>50_000:
        raise ResourceResult("budget_exceeded","observation_span")
    return alternate_blocks(state,dataset,inspection=True,**kwargs)


def _transform_annotations(data, *, offset=0, reverse_length=None):
    """Move all observed annotation geometry together, preserving call indexing.

    Unclipped source/family bounds must share the displayed interval's frame;
    edge-quality channels follow their physical edge through reflection.
    """
    def intervals(values):
        return [[a+offset, b+offset, *tail] if reverse_length is None else
                [reverse_length-b+offset, reverse_length-a+offset, *tail]
                for a, b, *tail in values]
    def point(value):
        return value+offset if reverse_length is None else reverse_length-1-value+offset
    for key in ("intervals", "fire"):
        if key in data:
            data[key] = intervals(data[key])
    for name, layer in data.get("layers", {}).items():
        for key in ("intervals", "source_intervals", "family_intervals"):
            if layer.get(key) is not None:
                layer[key] = intervals(layer[key])
        if reverse_length is not None and layer.get("qualities") is not None:
            from services.lift.compose import _swap_pairs
            qualities = layer["qualities"]
            for left, right in _swap_pairs(layer.get("quality_names"), name):
                if left < len(qualities) and right < len(qualities):
                    qualities[left], qualities[right] = qualities[right], qualities[left]
    for key in ("methyl_m6a", "methyl_m5c", "possible_deam_ct", "possible_deam_ga"):
        if key in data:
            data[key] = [point(value) for value in data[key]]
    if "deam" in data:
        data["deam"] = [[point(value), kind] for value, kind in data["deam"]]
