"""Whole-target evidence is joint within a path; equivalent wholes may union.

Assembly equality is intentionally absent from this algebra. A caller must
provide independently measured component/bridge/flank diagnostics from one
compatible hypothesis, then reconcile hypotheses and representations.
"""
from dataclasses import asdict, dataclass

from .calls import Call, Hypothesis, Representation, reconcile_hypotheses, reconcile_representations


@dataclass(frozen=True)
class JointPathEvidence:
    molecule_id: str
    representation_id: str
    source: str
    hypothesis_id: str
    path_id: str
    equivalent_representation_id: str
    required_components: tuple[str, ...]
    component_calls: tuple[tuple[str, Call], ...]
    bridge_and_flank_call: Call
    query_collinear: bool
    compatible_path: bool
    complete: bool
    ownership: str = "coequal"


def joint_call(evidence, target_id):
    components = dict(evidence.component_calls)
    required = set(evidence.required_components)
    if (len(components) != len(evidence.component_calls) or not required
            or set(components) != required or not evidence.path_id or not evidence.hypothesis_id
            or not evidence.query_collinear or not evidence.compatible_path or not evidence.complete):
        return Call(reasons=("incomplete_compound_path",))
    calls = [*components.values(), evidence.bridge_and_flank_call]
    witnesses = tuple(sorted({w for c in calls for w in c.witness_ids}))
    alignments = tuple(sorted({a for c in calls for a in c.alignment_ids}))
    # Every diagnostic must name this whole target; member-local targets cannot
    # accidentally supply the whole-target sequence assignment.
    if any(c.assignment != "target" or c.allele_id != target_id or c.level not in {"confirmed", "putative"}
           or c.method not in {"exact_sequence", "sequence_likelihood", "structural_path", "assembly_projection"} for c in calls):
        return Call(reasons=("missing_joint_diagnostics",), witness_ids=witnesses, alignment_ids=alignments)
    return Call("target", "putative" if any(c.level == "putative" for c in calls) else "confirmed",
                target_id, "structural_path", witness_ids=witnesses, alignment_ids=alignments,
                coverage=tuple(v for c in calls for v in c.coverage))


def whole_target_calls(evidence, *, target_id, scope="native_only", search_by_representation=None,
                       primary_complete_by_representation=None, required_by_representation=None):
    """One molecule vote, after joint-path and independent-copy reconciliation.

    Complete equivalent representations of a whole may supply the same
    hypothesis call. Partial member paths cannot. Dissenting hypotheses stay
    in the reduction even when one complete equivalent representation exists.
    """
    groups = {}
    for entry in evidence:
        groups.setdefault(entry.molecule_id, {}).setdefault(entry.representation_id, []).append(entry)
    result = {}
    for molecule, representations in groups.items():
        reps, diagnostics = [], []
        for identity, entries in representations.items():
            if len({e.source for e in entries}) != 1:
                raise ValueError("one representation cannot mix native and lifted evidence")
            hypotheses = {}
            for e in entries:
                requirements = (required_by_representation or {}).get(e.equivalent_representation_id)
                call = (Call(reasons=('compound_recipe_mismatch',)) if requirements is not None
                        and tuple(requirements) != e.required_components else joint_call(e, target_id))
                diagnostics.append({"evidence": asdict(e), "call": asdict(call)})
                hypotheses.setdefault(e.hypothesis_id, []).append((e, call))
            conditional = []
            for hid, paths in hypotheses.items():
                if len({e.ownership for e, _ in paths}) != 1:
                    raise ValueError("hypothesis ownership must be consistent")
                complete = [call for _, call in paths if call.assignment == "target"]
                # These are alternative encodings of one already compatible
                # whole path, never independently aligned native/lifted copies.
                call = complete[0] if complete else Call(reasons=("partial_compound_members",))
                if complete:
                    call = Call("target", "confirmed" if any(c.level == "confirmed" for c in complete) else "putative",
                                target_id, "structural_path",
                                witness_ids=tuple(sorted({w for c in complete for w in c.witness_ids})),
                                alignment_ids=tuple(sorted({a for c in complete for a in c.alignment_ids})),
                                coverage=tuple(v for c in complete for v in c.coverage))
                conditional.append(Hypothesis(hid, call, ownership=paths[0][0].ownership))
            reduced = reconcile_hypotheses(conditional,
                primary_complete=(primary_complete_by_representation or {}).get(identity, False),
                search=(search_by_representation or {}).get(identity))
            call = Call(**{**reduced["call"], **{k: tuple(reduced["call"][k]) for k in ("reasons", "witness_ids", "alignment_ids", "coverage")}})
            reps.append(Representation(identity, entries[0].source, call, complete=reduced['complete']))
        result[molecule] = {**reconcile_representations(reps, scope=scope), "joint_paths": diagnostics}
    return result


def phase_union(calls_by_occurrence):
    """Union complete occurrence calls once; never infer a molecule's phase."""
    molecules = {m for calls in calls_by_occurrence.values() for m in calls}
    result = {}
    for molecule in sorted(molecules):
        occurrences = {key: calls[molecule] for key, calls in calls_by_occurrence.items() if molecule in calls}
        carriers = [c for c in occurrences.values() if c.assignment == "target" and c.level in {"confirmed", "putative"}]
        compatible = len({c.allele_id for c in carriers}) <= 1
        result[molecule] = {"occurrences": {key: asdict(c) for key, c in occurrences.items()},
                            "carrier_vote": int(bool(carriers) and compatible), "inferred_phase": None,
                            "reasons": [] if compatible else ['incompatible_phase_occurrence_targets'],
                            "confirmed_vote": int(compatible and any(c.level == "confirmed" for c in carriers))}
    return result
