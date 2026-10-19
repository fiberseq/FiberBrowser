"""Opt-in v2 lifted summary/split adapter; legacy consumers remain default-deny.

The API produces one differences model. It does not feed composed alternatives
to the legacy strongest-evidence reducer, or install authoritative fields on
display rows. Variants and lens must pass their own convergence gates.
"""
from dataclasses import asdict, replace
import json
import os

from services.reconstruction_budget import DEFAULT_LIMITS, RESERVATIONS, ResourceResult
from .calls import Call, MembershipIndex, MoleculeId, Representation, reconcile_representations
from .identity import content_id, digest_file
from .likelihood import LikelihoodBudget, LikelihoodPolicy
from .model import SCHEMA_VERSION, VERSIONS
from .projection import (MapGap, MapPath, ProjectionBudget, ProjectionPolicy, SourceAlignment,
                         call_molecule, compose_alignment, _walk)
from .alleles import DafContext


def map_paths(config, chrom, start, end, *, policy, use_cache=True):
    """Selection is analysis policy scoped, independent of display toggles."""
    from services.lift import live_lift as ll
    from services.lift.differences import primary_gaps_for_region, _source_span
    settings = replace(config.settings,
                       cohort_alternatives=policy.cohort_alternatives)
    selection = ll.select_pieces(config.handle, chrom, start, end, haplotypes=config.haplotypes,
                                 settings=settings, key=config.key(), use_cache=use_cache)
    plan = ll.plan_fetch(selection, settings, fetch_range=(start, end))
    grouped = {}
    for p in selection.pieces:
        grouped.setdefault((p.chain, p.primary), []).append(p)
    paths = []
    handle = config.handle
    # Immutable observation/path namespace; fingerprint remains cache revision.
    namespace = content_id("map-target-content:v1", [digest_file(handle.path), *[
        digest_file(os.path.join(handle.map.dir, name)) for name in handle.manifest["target_files"][chrom]]])
    with handle.lock:
        for (ci, primary), pieces in grouped.items():
            chain = handle.map.chains[ci]
            if primary:
                raw_gaps = [g for c, g, _ in primary_gaps_for_region(handle, chrom, chain["haplotype"],
                    selection.start, selection.end) if c == ci]
            else:
                raw_gaps = handle.map.chain_data(ci)["gaps"]
            gaps = []
            for t, q, dt, dq, reason in raw_gaps:
                if t > selection.end or t + dt < selection.start:
                    continue
                a, b = _source_span(handle, chain, q, dq)
                gaps.append(MapGap(content_id("map-cut:v1", [namespace, ci, t, q, dt, dq]),
                                   a, b, t, t+dt, str(reason)))
            claims = tuple(dict(start=a, end=b, chain=other) for a, b, other in
                handle.map.nets.get((chain["haplotype"], handle.map.targets[chrom]), ())
                if primary and other != ci and any(a < p.t_end and b > p.t_start for p in pieces))
            paths.append(MapPath(content_id("map-path:v1", [namespace, ci, primary]), chrom,
                pieces[0].source, tuple(pieces), tuple(gaps), "primary" if primary else "secondary",
                handle.fingerprint, ownership_validated=primary, map_content_id=namespace, ownership_witnesses=claims))
    return paths, plan, selection.alternatives_capped


def _source_records(dataset, plan, *, include_sequence, include_duplicates, budget):
    from services.bam_handles import get_bam_handle
    from services.signal_evidence import record_keeps_signal, signal_header
    from services.graph_lift import lift_hidden_predicate
    from services.sv_molecules import molecule_bundles, MoleculeBudgetError
    config = dataset.live_lift
    groups = config.settings.molecule_group_map(dataset.paths, dataset.id)
    seen = set()
    for path in dataset.paths:
        budget.check()
        bam = get_bam_handle(path)
        if bam is None:
            raise ResourceResult("unavailable", "source_bam_unavailable")
        signal, hidden = signal_header(bam.header), lift_hidden_predicate(bam.header)
        def raw_records():
            raw_seen, scanned = set(), 0
            for fetch in plan.contigs:
                if fetch.contig not in bam.references:
                    continue
                for a, b in fetch.windows:
                    occurrences = {}
                    for read in bam.fetch(fetch.contig, a, b):
                        budget.check()
                        scanned += 1
                        if scanned > 200_000:
                            raise ResourceResult("budget_exceeded", "projection_scan_records_cap")
                        import hashlib
                        sha = hashlib.sha256(read.to_string().encode()).hexdigest()
                        occurrence = occurrences.get(sha, 0)
                        occurrences[sha] = occurrence + 1
                        key = (sha, occurrence)
                        if key in raw_seen:
                            continue
                        raw_seen.add(key)
                        yield read

        def eligible(read):
            budget.check()
            if read.is_unmapped or read.is_secondary or (hidden is not None and hidden(read)):
                return None
            if config.settings.cohort_supplementaries == "primary_only" and read.is_supplementary:
                return None
            # A rejected primary is retained as a bundle tombstone so an
            # eligible supplementary cannot resurrect its excluded molecule.
            return (include_duplicates or not read.is_duplicate) and record_keeps_signal(read, signal)

        try:
            for bundle in molecule_bundles(raw_records(), eligible):
                occurrences = {}
                hydrated = _hydrate_bundle(bam, bundle, config, budget)
                if any(not r.is_supplementary and eligible(r) is False for r in hydrated):
                    continue
                for read in hydrated:
                    if not eligible(read):
                        continue
                    molecule = MoleculeId("declared_source_library", groups[path], read.query_name)
                    record = SourceAlignment.from_bam(read, molecule, include_sequence=include_sequence)
                    occurrence = occurrences.get(record.record_sha256, 0)
                    occurrences[record.record_sha256] = occurrence + 1
                    if occurrence:
                        record = SourceAlignment.from_bam(read, molecule, include_sequence=include_sequence, record_occurrence=occurrence)
                    if record.record_id in seen:
                        continue
                    try:
                        budget.charge("records", 1, budget.policy.max_records)
                        budget.charge("bases", _walk(record)[4], budget.policy.max_input_bases)
                    except ResourceResult as exc:
                        exc.parameters["interrupted_molecule"] = molecule.key
                        raise
                    seen.add(record.record_id)
                    yield record
        except MoleculeBudgetError as exc:
            raise ResourceResult("budget_exceeded", "projection_molecule_spool") from exc


def _hydrate_bundle(bam, bundle, config, budget):
    """Bounded reciprocal SA lookup, including an off-window actual primary.

    A tag without its actual record remains a source/query witness. Unmatched
    or unprojectable tags supply neither target chromosomes nor conflict votes.
    """
    if not config.settings.primary_lookup or config.settings.cohort_supplementaries == "primary_only":
        return bundle
    found = list(bundle)
    keys = {(r.reference_name, r.reference_start, r.cigarstring, r.is_reverse) for r in bundle}
    lookups = getattr(budget, "sa_lookups", 0)
    for read in bundle:
        if not read.has_tag("SA"):
            continue
        for entry in read.get_tag("SA").split(";"):
            budget.check()
            parts = entry.split(",")
            if len(parts) != 6:
                continue
            try:
                chrom, pos, strand, cigar = parts[0], int(parts[1])-1, parts[2], parts[3]
            except ValueError:
                continue
            key = (chrom, pos, cigar, strand == "-")
            if key in keys or chrom not in bam.references or pos < 0 or lookups >= 64:
                continue
            lookups += 1
            budget.sa_lookups = lookups
            for n, candidate in enumerate(bam.fetch(chrom, pos, pos+1)):
                budget.check()
                if n >= 4096:
                    break
                if candidate.is_unmapped or candidate.is_secondary or candidate.query_name != read.query_name:
                    continue
                if (candidate.reference_name, candidate.reference_start, candidate.cigarstring, candidate.is_reverse) != key:
                    continue
                reciprocal = f"{read.reference_name},{read.reference_start+1},{'-' if read.is_reverse else '+'},{read.cigarstring},"
                if not candidate.has_tag("SA") or not any(e.startswith(reciprocal) for e in candidate.get_tag("SA").split(";")):
                    continue
                keys.add(key)
                found.append(candidate)
                break
    return found


def _public_projection(detail):
    """No full observations in ordinary responses, including nested diagnostics."""
    for record in detail.get("diagnostics", []):
        for d in record["records"]:
            for edit in d["projection"]["edits"]:
                sequence = edit.pop("observed", None)
                edit["read_bases"] = sequence[:60] if sequence is not None else None
                edit["read_bases_length"] = len(sequence) if sequence is not None else edit["alt_bp"]
    return detail


def projected_analysis(state, dataset, *, policy=None, **kwargs):
    """Reserve linear geometry/sequence/output storage before starting I/O.

    Likelihood reserves its rolling rows separately. Geometry never takes the
    large DP slot, so nested likelihood reservations cannot deadlock on it.
    Half the request ceiling remains available to numerical alignment work.
    """
    from services.lift.capability import require
    require(dataset, "difference_" + kwargs.get("feature", ""))
    if dataset is None or dataset.data_type != "bam_livelift":
        raise ValueError("a live-lift dataset is required")
    policy = policy or ProjectionPolicy(cohort_alternatives=dataset.live_lift.settings.cohort_alternatives)
    budget = ProjectionBudget(policy)
    reserved = (2*policy.max_response_bytes + 2048*policy.max_runs +
                32*policy.max_input_bases + 4096*policy.max_records)
    if reserved > min(DEFAULT_LIMITS.job_bytes, DEFAULT_LIMITS.request_bytes//2):
        raise ResourceResult("budget_exceeded", "projection_request_bytes", reserved_bytes=reserved)
    RESERVATIONS.acquire(reserved, False, budget.deadline, budget.check)
    try:
        return _projected_analysis(state, dataset, policy=policy, budget=budget, **kwargs)
    finally:
        RESERVATIONS.release(reserved, False)


def _projected_analysis(state, dataset, *, chrom, start, end, feature, target=None,
                       policy=None, include_duplicates=False, contexts=None, use_cache=True,
                       native_dataset_id=None, analysis_scope="lifted_only", budget):
    """A bounded, loaded cohort with independent summary and split gates."""
    from services.lift.capability import require
    from services.lift.registration import require_enabled
    require_enabled()
    if feature not in {"summary", "split"}:
        raise ValueError("unsupported projected analysis")
    require(dataset, "difference_" + feature)
    if dataset is None or dataset.data_type != "bam_livelift":
        raise ValueError("a live-lift dataset is required")
    if analysis_scope not in {"lifted_only", "combined"}:
        raise ValueError("native_only uses the independent native SV service")
    if analysis_scope == "combined" and not native_dataset_id:
        raise ValueError("combined scope requires an independent native dataset")
    if analysis_scope == "lifted_only" and native_dataset_id:
        raise ValueError("native_dataset_id requires combined scope")
    if type(start) is not int or type(end) is not int or not 0 <= start < end or end-start > 2_000_000:
        raise ValueError("bounded nonempty target region required")
    policy = policy or ProjectionPolicy(cohort_alternatives=dataset.live_lift.settings.cohort_alternatives)
    if feature == "split":
        target = validate_target(target, chrom, start, end, policy)
    records, reasons, interrupted = [], [], set()
    try:
        paths, plan, alternatives_capped = map_paths(dataset.live_lift, chrom, start, end, policy=policy, use_cache=use_cache)
    except (OSError, ValueError) as exc:
        if analysis_scope != "combined":
            raise ResourceResult("unavailable", "map_unavailable") from exc
        from types import SimpleNamespace
        paths, alternatives_capped = [], 0
        plan = SimpleNamespace(contigs=[], source_bp=0, pieces_by_contig=lambda: {})
        reasons.append("map_unavailable")
    try:
        if paths:
            records.extend(_source_records(dataset, plan, include_sequence=bool(target and target.get("target_type") == "exact"),
                include_duplicates=include_duplicates, budget=budget))
    except ResourceResult as exc:
        reasons.append(exc.reason)
        if exc.parameters.get("interrupted_molecule"):
            interrupted.add(exc.parameters["interrupted_molecule"])
    grouped = {}
    for a in records:
        grouped.setdefault(a.molecule.key, []).append(a)
    native, native_interrupted = {}, set()
    if native_dataset_id:
        native, native_reasons, native_interrupted = native_bundles(state, native_dataset_id, chrom, start, end,
            include_sequence=bool(target and target.get("target_type") == "exact"),
            include_duplicates=include_duplicates, budget=budget)
        reasons.extend(native_reasons)
    if feature == "summary":
        # Discovery retains path membership; clustering is candidate geometry
        # only. Classification below never pools these mutually exclusive paths.
        geometries = {}
        namespace = paths[0].map_content_id if paths else content_id("unresolved-reference:v1", chrom)
        try:
            discovery = [(a, paths) for a in records]
            discovery += [(a, [native_path(aa, chrom)]) for aa in native.values() for a in aa]
            for a, candidate_paths in discovery:
                for p in candidate_paths:
                    if p.source != a.contig:
                        continue
                    projected = compose_alignment(a, p, budget=budget)
                    for e in projected["edits"]:
                        if max(e["ref_end"]-e["ref_start"], e["alt_bp"]) < 10:
                            continue
                        if not start <= e["ref_start"] < end and not (e["ref_start"] < end and e["ref_end"] > start):
                            continue
                        key = (e["ref_start"], e["ref_end"], e["alt_bp"])
                        geometries[key] = dict(target_id=content_id("projected-geometry:v1", [namespace, chrom, *key]),
                            revision=1, target_type="geometry", chrom=chrom, ref_start=key[0], ref_end=key[1], alt_bp=key[2])
                        if len(geometries) > policy.max_targets:
                            del geometries[key]
                            raise ResourceResult("budget_exceeded", "projection_targets_cap")
        except ResourceResult as exc:
            reasons.append(exc.reason)
        targets = list(geometries.values())
    else:
        targets = [target]
    output = []
    membership = MembershipIndex()
    for a in records:
        membership.add(dataset.id, a.record_id, a.molecule)
        add_display_memberships(membership, dataset, a, plan)
    for aa in native.values():
        for a in aa:
            membership.add(native_dataset_id, a.record_id, a.molecule)
    # Raw row aliases are dataset qualified and only unambiguous libraries fan out.
    for did, aliases in membership.payload()["legacy_aliases"].items():
        for name, molecule_key in aliases.items():
            membership.rows[did][name] = molecule_key
    likelihood_policy = LikelihoodPolicy()
    likelihood_budget = LikelihoodBudget(likelihood_policy)
    calls_used = response_bytes = 0
    for t in targets:
        calls, counts, geometry_counts = {}, [0, 0, 0], [0, 0, 0]
        for key in dict.fromkeys([*grouped, *native]):
            if calls_used >= policy.max_calls:
                reasons.append("projection_calls_cap")
                break
            calls_used += 1
            aa = grouped.get(key) or native[key]
            try:
                budget.check()
                raw_context = (contexts or {}).get(aa[0].molecule.raw_name)
                context = DafContext(**raw_context) if raw_context is not None else None
                detail = call_molecule(grouped.get(key, []), paths, t, policy=policy, budget=budget, context=context,
                    likelihood_policy=likelihood_policy, likelihood_budget=likelihood_budget)
                if key in interrupted:
                    detail["complete"] = False
                    if not detail["available"]:
                        detail["available"] = True
                        detail["call"] = asdict(Call(reasons=("projection_records_cap",)))
                if alternatives_capped:
                    # select_pieces' independent secondary cap cannot invalidate
                    # complete primary ownership, but coequal fallback is incomplete.
                    from .calls import reconcile_hypotheses, Hypothesis
                    search = detail["search"] or {}
                    search["search_complete"] = False
                    search.setdefault("unexplored", []).append(dict(outcome="unexplored", ownership="secondary", reason="map_alternatives_cap"))
                    hs = [Hypothesis(**h) if isinstance(h["call"], Call) else Hypothesis(**{**h, "call": Call(**h["call"])}) for h in detail["hypotheses"]]
                    result = reconcile_hypotheses(hs, primary_complete=detail["primary_complete"], search=search)
                    detail.update(result)
                    gh = [Hypothesis(**{**h, "call": Call(**h["call"])}) for h in detail["geometry_hypotheses"]]
                    detail["geometry_call"] = reconcile_hypotheses(gh, primary_complete=detail["primary_complete"], search=search)["call"]
                representation = Representation("lifted", "lifted", Call(**detail["call"]),
                    admissible=detail["available"], complete=detail["complete"])
                representations = [representation]
                geometry_representations = [replace(representation, call=Call(**detail["geometry_call"]))]
                native_detail = None
                if analysis_scope == "combined":
                    if key in native:
                        native_detail = native_call(native[key], t, policy=policy, budget=budget,
                            context=context, likelihood_budget=likelihood_budget)
                        if key in native_interrupted:
                            native_detail["complete"] = False
                        representations.append(Representation("native", "native", Call(**native_detail["call"]),
                            complete=native_detail["complete"]))
                        geometry_representations.append(Representation("native", "native", Call(**native_detail["geometry_call"]), complete=native_detail["complete"]))
                    elif key in native_interrupted:
                        representations.append(Representation("native", "native", Call(reasons=("projection_records_cap",)), complete=False))
                        geometry_representations.append(representations[-1])
                    else:
                        representations.append(Representation("native", "native", Call("unavailable", reasons=("native_copy_not_loaded",)), admissible=False))
                        geometry_representations.append(representations[-1])
                final = reconcile_representations(representations, scope=analysis_scope)
                geometry_final = reconcile_representations(geometry_representations, scope=analysis_scope)
                calls[key] = {**final, "geometry_evidence": geometry_final["call"], "lifted": _public_projection(detail)}
                if native_detail is not None:
                    calls[key]["native"] = _public_projection(native_detail)
            except ResourceResult as exc:
                reasons.append(exc.reason)
                calls[key] = {"call": asdict(Call(reasons=(exc.reason,))), "representations": [], "complete": False}
            call = calls[key]["call"]
            group = 0 if call["assignment"] == "target" and call["level"] in {"confirmed", "putative"} else 1 if call["assignment"] == "reference" else 2
            counts[group] += 1
            geometry = calls[key].get("geometry_evidence", {})
            geometry_group = 0 if geometry.get("assignment") == "target" and geometry.get("level") in {"confirmed", "putative"} else 1 if geometry.get("assignment") == "reference" else 2
            geometry_counts[geometry_group] += 1
            response_bytes += len(json.dumps(calls[key]).encode())
            if response_bytes > policy.max_response_bytes:
                return dict(schema_version=SCHEMA_VERSION, status="budget_exceeded", reason="projection_response_bytes",
                            scope=dict(search_complete=False, reasons=["projection_response_bytes"]), targets=[])
        output.append(dict(target=t, calls_by_molecule=calls, counts=counts,
            geometry_counts=geometry_counts, sequence_unresolved_count=sum(v["call"]["assignment"] in {"unknown", "ambiguous"} for v in calls.values()),
            groups=["carriers", "reference", "not informative"],
            row_assignments={d: membership.fan_out(d, {k: v["call"] for k, v in calls.items()})
                             for d in [dataset.id, *([native_dataset_id] if native_dataset_id else [])]}))
        if calls_used >= policy.max_calls:
            break
    payload = dict(schema_version=SCHEMA_VERSION, feature=feature, analysis_scope=analysis_scope,
        versions={**VERSIONS, "projection": policy.version}, policy=asdict(policy), targets=output,
        membership=membership.payload(), scope=dict(chrom=chrom, start=start, end=end, cohort="loaded",
            records=len(records)+sum(map(len, native.values())), molecules=len(set(grouped) | set(native)), source_bp=plan.source_bp,
            search_complete=not reasons and not alternatives_capped and all(v.get("lifted", {}).get("search", {}).get("search_complete", False) for o in output for v in o["calls_by_molecule"].values()),
            primary_calls_complete=all(v["complete"] for o in output for v in o["calls_by_molecule"].values()),
            sequence_enrichment_complete=(all(d.get("sequence_assessment", {}).get("complete", False)
                for o in output for v in o["calls_by_molecule"].values() for h in v.get("lifted", {}).get("diagnostics", []) for d in h["records"])
                if target and target.get("target_type") == "exact" else None),
            reasons=sorted(set(reasons)), alternatives_capped=alternatives_capped,
            unresolved_source_witnesses=sum(len(v.get("lifted", {}).get("unprojectable_witnesses", [])) for o in output for v in o["calls_by_molecule"].values()),
            map_revision=paths[0].map_revision if paths else None, sequence_enriched=bool(target and target.get("target_type") == "exact")))
    if len(json.dumps(payload).encode()) > policy.max_response_bytes:
        return dict(schema_version=SCHEMA_VERSION, status="budget_exceeded", reason="projection_response_bytes",
                    scope={**payload["scope"], "search_complete": False}, targets=[])
    return payload


def native_bundles(state, dataset_id, chrom, start, end, *, include_sequence, include_duplicates, budget):
    """Independent native adapter. It never requests a map or lifted rows."""
    from services.sv_endpoint import _bam_records
    dataset = state.datasets.get(dataset_id)
    if dataset is None or dataset.data_type != "bam":
        raise ValueError("native_dataset_id must name a native BAM")
    labels = dict(getattr(dataset, "molecule_groups", ()) or ())
    groups = {p: labels.get(p) or f"{dataset_id}#{i}" for i, p in enumerate(dataset.paths)}
    grouped, seen, reasons, blocked, interrupted = {}, set(), [], set(), set()
    current_molecule = None
    try:
        for read, _, path, _ in _bam_records(state, dataset_id, chrom, start, end, with_handle=True, checkpoint_fn=budget.check):
            molecule = MoleculeId("declared_source_library", groups[path], read.query_name)
            current_molecule = molecule.key
            if read.is_duplicate and not include_duplicates:
                if not read.is_supplementary:
                    blocked.add(molecule.key)
                continue
            a = SourceAlignment.from_bam(read, molecule, include_sequence=include_sequence)
            if a.record_id in seen:
                continue
            budget.charge("records", 1, budget.policy.max_records)
            budget.charge("bases", _walk(a)[4], budget.policy.max_input_bases)
            seen.add(a.record_id)
            grouped.setdefault(molecule.key, []).append(a)
    except ResourceResult as exc:
        reasons.append(exc.reason)
        if current_molecule:
            interrupted.add(current_molecule)
    return {k: v for k, v in grouped.items() if k not in blocked}, reasons, interrupted


def native_call(alignments, target, *, policy, budget, context, likelihood_budget):
    """Identity-coordinate CIGAR producer, independent of any assembly service."""
    path = native_path(alignments, target.get("chrom", alignments[0].contig))
    result = call_molecule(alignments, [path], target, policy=policy, budget=budget,
                          context=context, likelihood_budget=likelihood_budget)
    # Provenance is explicit even though the coordinate-walk implementation is shared.
    result["call"]["method"] = "native_cigar" if target["target_type"] == "geometry" else result["call"]["method"]
    result["source"] = "reads"
    result["representation"] = "native"
    return result


def native_path(alignments, chrom):
    from collections import namedtuple
    Block = namedtuple("NativeBlock", "chain t_start t_end q_start q_end strand primary hap source")
    size = max(_walk(a)[3] for a in alignments) + 1
    source = alignments[0].contig
    return MapPath("native-reference-path", chrom, source,
        (Block("native", 0, size, 0, size, "+", True, None, source),),
        ownership="primary", ownership_validated=True)


def add_display_memberships(index, dataset, alignment, plan):
    """Reuse row partition/identity recipes, without chromatin decode or calls."""
    from services.lift.compose import _read_rows, _placement
    from services.lift.cohort import analysis_id
    pieces = plan.pieces_by_contig().get(alignment.contig, [])
    numbered = {}
    for row in _read_rows(dict(reference_start=alignment.ref_start, reference_end=_walk(alignment)[3]),
                          (pieces, [p.q_start for p in pieces]), dataset.live_lift.settings):
        placement = _placement(row)
        row_index = numbered.get(placement, 0)
        numbered[placement] = row_index+1
        ll = dict(molecule=f"{alignment.molecule.library_id}|{alignment.molecule.raw_name}",
                  record=f"{alignment.record_sha256}:{alignment.record_occurrence}",
                  row_index=row_index, placement=placement)
        identity = analysis_id(dict(id=alignment.molecule.raw_name, live_lift=ll), dataset.live_lift.settings)
        index.add(dataset.id, identity, alignment.molecule, analysis_id=identity)


def validate_target(target, chrom, start, end, policy):
    if not isinstance(target, dict):
        raise ValueError("split requires a frozen target")
    target = dict(target)
    target.setdefault("revision", 1)
    if type(target["revision"]) is not int or target["revision"] < 1:
        raise ValueError("positive frozen target revision required")
    for k in ("ref_start", "ref_end", "alt_bp"):
        if type(target.get(k)) is not int or target[k] < 0:
            raise ValueError("invalid target geometry")
    if not start <= target["ref_start"] <= target["ref_end"] <= end:
        raise ValueError("target outside requested region")
    if max(target["ref_end"]-target["ref_start"], target["alt_bp"]) > policy.max_sequence_bp:
        raise ValueError("target exceeds sequence budget")
    if target.get("target_type") not in {"geometry", "exact"} or not target.get("target_id"):
        raise ValueError("explicit target identity/type required")
    if target.get("chrom", chrom) != chrom:
        raise ValueError("target chromosome mismatch")
    if target["target_type"] == "exact":
        ds, de = target.get("diagnostic_start", target["ref_start"]), target.get("diagnostic_end", target["ref_end"])
        if type(ds) is not int or type(de) is not int or not 0 <= ds <= target["ref_start"] <= target["ref_end"] <= de or de-ds > policy.max_sequence_bp:
            raise ValueError("bounded common diagnostic window required")
        candidates = target.get("candidates") or {}
        if not isinstance(candidates, dict) or len(candidates) > 32:
            raise ValueError("bounded competing alleles required")
        if any(v is not None and (not isinstance(v, str) or len(v) > policy.max_sequence_bp) for v in candidates.values()):
            raise ValueError("bounded complete candidate strings required")
        for identity, size in ((target["target_id"], target["alt_bp"]+de-ds-(target["ref_end"]-target["ref_start"])), ("reference", de-ds)):
            if candidates.get(identity) is not None and len(candidates[identity]) != size:
                raise ValueError("candidate length differs from frozen geometry")
    return target
