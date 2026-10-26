"""Executable sequence/DAF contracts for the phase-1 spike.

Exact assignment is diagnostic and conservative. The DAF transition matrix is
an orientation oracle, NOT a calibrated per-molecule caller (phase 2). Unknown
chemistry, ambiguous conversion-only diagnostics and partial scans stay unknown.
"""
from dataclasses import dataclass

from .calls import Call

_COMPLEMENT = str.maketrans("ACGT", "TGCA")


# Chemistry read from a BAM st tag. FiberHMM's st (fiberhmm/daf/encoder.py) counts reference C>T versus G>A on the
# stored, reference-forward SEQ, so it is already in the stored-SEQ frame: only a projection that reverse-complements
# that SEQ (a minus-chain lift) complements it, never the read's own orientation.
ST_TAG_PROVENANCE = frozenset({"BAM:st", "bam_st_tag"})


def stored_frame_chemistry(context) -> bool:
    return context is not None and getattr(context, "provenance", None) in ST_TAG_PROVENANCE


@dataclass(frozen=True)
class DafContext:
    chemistry: str  # molecule chemistry; never swapped by target orientation
    provenance: str
    reverse_complemented: bool = False
    conversion_rate: float | None = None
    substitution_rate: float = 0.01
    base_qualities: tuple[int, ...] = ()
    likelihood_version: str = 'contract:v1'


@dataclass(frozen=True)
class StructuralProof:
    target_id: str
    version: str
    observed_flanks: int
    query_collinear: bool
    compatible_path: bool
    competing_paths_excluded: bool
    search_complete: bool


def transition_probability(allele, observed, *, chemistry, reverse_complemented=False,
                           conversion_rate=0.9, substitution_rate=0.01):
    if chemistry not in {"CT", "GA"}:
        raise ValueError("unknown chemistry requires a calibrated marginal model")
    if not 0 <= conversion_rate <= 1 or not 0 <= substitution_rate < 1:
        raise ValueError("invalid likelihood parameters")
    if reverse_complemented:
        allele, observed = allele.translate(_COMPLEMENT), observed.translate(_COMPLEMENT)
    if allele not in "ACGT" or observed not in "ACGT" or len(allele) != 1 or len(observed) != 1:
        raise ValueError("unambiguous bases required")
    donor, converted = ("C", "T") if chemistry == "CT" else ("G", "A")
    if allele == donor:
        return ((1 - conversion_rate) * ((1 - substitution_rate) if observed == donor else substitution_rate / 3)
                + conversion_rate * ((1 - substitution_rate) if observed == converted else substitution_rate / 3))
    return (1 - substitution_rate) if allele == observed else substitution_rate / 3


def diagnostic_assignment(observed, candidates, *, target_id, complete, chemistry="unknown",
                          reverse_complemented=False, geometry_level="confirmed", structural_path=False):
    """Small independent-string contract, not the noisy/indel likelihood caller.

    ``candidates`` includes reference and all competitors before display filters.
    The caller must attest that ``observed`` is complete, never a preview.
    """
    if structural_path:
        if (isinstance(structural_path, StructuralProof) and structural_path.target_id == target_id
                and structural_path.version and structural_path.observed_flanks == 2
                and structural_path.query_collinear and structural_path.compatible_path
                and structural_path.competing_paths_excluded and structural_path.search_complete):
            return Call("target", geometry_level, target_id, "structural_path")
        return Call(reasons=('incomplete_structural_proof',))
    if observed is None or not complete or any(value is None for value in candidates.values()):
        return Call(reasons=("diagnostic_sequence_unavailable",))
    if chemistry not in {"none", "CT", "GA"}:
        return Call(reasons=("unknown_chemistry",))
    if any(base not in "ACGT" for sequence in (observed, *candidates.values()) for base in sequence.upper()):
        return Call(reasons=("ambiguous_bases",))
    observed = observed.upper()
    compatible = []
    for identity, expected in candidates.items():
        expected = expected.upper()
        if chemistry == "none":
            match = observed == expected
        else:
            donor, converted = ("C", "T") if chemistry == "CT" else ("G", "A")
            if reverse_complemented:
                donor, converted = donor.translate(_COMPLEMENT), converted.translate(_COMPLEMENT)
            match = len(observed) == len(expected) and all(a == b or (a == donor and b == converted) for a, b in zip(expected, observed))
        if match:
            compatible.append(identity)
    if len(compatible) > 1:
        return Call("ambiguous", "ambiguous", reasons=("competing_diagnostics",))
    if not compatible:
        return Call(reasons=("uncalibrated_sequence_noise",))
    identity = compatible[0]
    assignment = "target" if identity == target_id else "reference" if identity == "reference" else "other_allele"
    # Conversion tolerance is not exact equality and cannot claim confirmation
    # until the phase-2 likelihood has been calibrated.
    return Call(assignment, geometry_level if chemistry == "none" else "putative", identity,
                "exact_sequence" if chemistry == "none" else "sequence_likelihood",
                () if chemistry == "none" else ("uncalibrated_daf_contract",))
