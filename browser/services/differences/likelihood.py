"""Quality-aware DAF allele competition with bounded global indel alignment.

The engineering profile is deliberately uncalibrated on biological truth:
likelihood calls are putative until a separately validated profile is supplied.
Conversion-channel ties remain ambiguous even when an arbitrary rate would
prefer one allele. Exact undeaminated strings use a separate assignment method.
"""
from dataclasses import asdict, dataclass
import math
import time

from services.background_work import checkpoint
from services.reconstruction_budget import DEFAULT_LIMITS, RESERVATIONS, ResourceResult
from .alleles import DafContext, transition_probability
from .calls import Call

LIKELIHOOD_VERSION = "daf-indel:v3"


@dataclass(frozen=True)
class LikelihoodPolicy:
    version: str = LIKELIHOOD_VERSION
    profile_id: str = "engineering-synthetic:v1"
    calibration_id: str | None = None
    substitution_rate: float = .01
    indel_rate: float = .02
    conversion_rate: float = .90
    min_log_odds: float = math.log(100)
    max_noise_fraction: float = .20
    max_candidates: int = 32
    max_pair_cells: int = 2_000_000
    max_request_cells: int = 10_000_000
    max_sequence_bp: int = 100_000
    deadline_s: float = 30.

    def __post_init__(self):
        if not 0 < self.substitution_rate < .25 or not 0 < self.indel_rate < .25 or not 0 <= self.conversion_rate <= 1:
            raise ValueError("invalid likelihood rates")
        if self.min_log_odds <= 0 or not 0 < self.max_noise_fraction < 1 or self.deadline_s <= 0:
            raise ValueError("invalid likelihood thresholds")
        for key in ("max_candidates", "max_pair_cells", "max_request_cells", "max_sequence_bp"):
            if type(getattr(self, key)) is not int or getattr(self, key) < 1:
                raise ValueError("positive integer likelihood limits required")


class LikelihoodBudget:
    def __init__(self, policy=LikelihoodPolicy()):
        self.policy, self.cells = policy, 0
        self.deadline = time.monotonic() + policy.deadline_s

    def check(self):
        checkpoint()
        if time.monotonic() >= self.deadline:
            raise ResourceResult("budget_exceeded", "likelihood_deadline")

    def validate_bases(self, pairs):
        self.check()
        if any(max(n, m) > min(self.policy.max_sequence_bp, DEFAULT_LIMITS.max_reconstructed_bases) for n, m in pairs):
            raise ResourceResult("budget_exceeded", "likelihood_bases")

    def charge(self, cells):
        self.check()
        if any(c > min(self.policy.max_pair_cells, DEFAULT_LIMITS.pair_cells) for c in cells):
            raise ResourceResult("budget_exceeded", "likelihood_pair_cells")
        if self.cells + sum(cells) > min(self.policy.max_request_cells, DEFAULT_LIMITS.request_cells):
            raise ResourceResult("budget_exceeded", "likelihood_request_cells")
        self.cells += sum(cells)


def _emission(expected, observed, quality, context, policy):
    error = max(policy.substitution_rate, context.substitution_rate, 10 ** (-quality / 10)) if quality is not None else max(policy.substitution_rate, context.substitution_rate)
    error = min(.74, error)
    if context.chemistry == "none":
        return 1 - error if expected == observed else error / 3
    return transition_probability(expected, observed, chemistry=context.chemistry,
        reverse_complemented=context.reverse_complemented,
        conversion_rate=policy.conversion_rate if context.conversion_rate is None else context.conversion_rate,
        substitution_rate=error)


def _band(observed, expected, context, policy, budget):
    """Certify a band containing every optimal global likelihood path.

    A diagonal path with trailing gaps supplies a feasible lower score. Every
    emission is <= 0 log probability. Excursions beyond the endpoint diagonals
    require extra insertion/deletion pairs; their gap cost alone excludes paths
    scoring below that lower bound. This is not a heuristic alignment band.
    """
    gap = math.log(policy.indel_rate)
    insertion = gap - math.log(4)
    delta = len(observed) - len(expected)
    mandatory = max(0, delta) * insertion + max(0, -delta) * gap
    lower = mandatory
    for i, (o, e) in enumerate(zip(observed, expected)):
        if not i & 255:
            budget.check()
        quality = context.base_qualities[i] if context.base_qualities else None
        lower += math.log(max(1e-300, _emission(e, o, quality, context, policy)))
    extra = math.ceil(max(0., mandatory - lower) / -(insertion + gap)) + 1
    return min(0, delta) - extra, max(0, delta) + extra


def _band_cells(n, m, band, budget):
    low, high = band
    cells = 0
    for i in range(n + 1):
        if not i & 255:
            budget.check()
        cells += max(0, min(m, i - low) - max(0, i - high) + 1)
    return cells


def _score(observed, expected, context, policy, budget, band=None):
    """Global maximum-likelihood edit path; two bounded rolling score rows.

    This is an indel-aware likelihood score, not a posterior probability.
    A second path cost tracks nonconversion noise for an absolute-fit guard.
    """
    gap = math.log(policy.indel_rate)
    low, high = band if band is not None else (-len(expected), len(observed))
    previous_start = 0
    previous = [(j * gap, j) for j in range(min(len(expected), -low) + 1)]
    donor, converted = ("C", "T") if context.chemistry == "CT" else ("G", "A")
    if context.reverse_complemented:
        donor, converted = donor.translate(str.maketrans("ACGT", "TGCA")), converted.translate(str.maketrans("ACGT", "TGCA"))
    for i, observed_base in enumerate(observed, 1):
        budget.check()
        quality = context.base_qualities[i - 1] if context.base_qualities else None
        start, end = max(0, i - high), min(len(expected), i - low)
        row = []
        emissions = {base: math.log(max(1e-300, _emission(base, observed_base, quality, context, policy))) for base in "ACGT"}
        for j in range(start, end + 1):
            if not j & 255:
                budget.check()
            options = []
            if j and previous_start <= j - 1 < previous_start + len(previous):
                expected_base = expected[j - 1]
                score, noise = previous[j - 1 - previous_start]
                mismatch = int(expected_base != observed_base and not
                    (context.chemistry in {"CT", "GA"} and expected_base == donor and observed_base == converted))
                options.append((score + emissions[expected_base], noise + mismatch))
            if previous_start <= j < previous_start + len(previous):
                score, noise = previous[j - previous_start]
                options.append((score + gap - math.log(4), noise + 1))
            if row:
                options.append((row[-1][0] + gap, row[-1][1] + 1))
            row.append(max(options, key=lambda v: (v[0], -v[1])))
        previous, previous_start = row, start
    return previous[-1]


def _conversion_signature(sequence, context):
    donor, converted = ("C", "T") if context.chemistry == "CT" else ("G", "A")
    if context.reverse_complemented:
        donor, converted = donor.translate(str.maketrans("ACGT", "TGCA")), converted.translate(str.maketrans("ACGT", "TGCA"))
    return sequence.replace(donor, converted)


def compete(observed, candidates, *, target_id, complete, context=None, geometry_level="confirmed",
            policy=LikelihoodPolicy(), budget=None):
    """All competitors and reference must be supplied before source filtering.

    Complete means a full observed diagnostic interval with both flanks/path,
    not a preview. Missing competitor sequence blocks a decisive assignment.
    Scores, runner-up separation and calibration provenance remain inspectable.
    """
    context = context or DafContext("unknown", "unavailable")
    if ((context.conversion_rate is not None and
         (not isinstance(context.conversion_rate, (int, float)) or not 0 <= context.conversion_rate <= 1))
            or not isinstance(context.substitution_rate, (int, float)) or not 0 <= context.substitution_rate < 1):
        raise ValueError("invalid molecule conversion/noise rates")
    budget = budget or LikelihoodBudget(policy)
    if budget.policy != policy:
        raise ValueError("one request must use one likelihood policy")
    base = {"policy": asdict(policy), "context": asdict(context), "scores": {}, "complete": False}
    # Full sequences and per-base qualities are deliberately not returned.
    base["context"]["base_qualities"] = {"count": len(context.base_qualities)}
    def result(call, **extra):
        return {**base, "call": asdict(call), **extra}
    if observed is None or not complete or target_id not in candidates or "reference" not in candidates or any(v is None for v in candidates.values()):
        return result(Call(reasons=("diagnostic_sequence_unavailable",)))
    if context.chemistry not in {"none", "CT", "GA"} or not context.provenance:
        return result(Call(reasons=("unknown_chemistry",)))
    if context.base_qualities and (len(context.base_qualities) != len(observed) or any(q < 0 or q > 93 for q in context.base_qualities)):
        raise ValueError("qualities must match the observed target-oriented sequence")
    observed = observed.upper()
    candidates = {k: v.upper() for k, v in candidates.items()}
    if any(b not in "ACGT" for seq in (observed, *candidates.values()) for b in seq):
        return result(Call(reasons=("ambiguous_bases",)))
    try:
        if len(candidates) > policy.max_candidates:
            raise ResourceResult("budget_exceeded", "likelihood_candidates")
        budget.validate_bases([(len(observed), len(seq)) for seq in candidates.values()])
        exact_matches = [key for key, sequence in candidates.items() if sequence == observed]
        if (context.chemistry == "none" and len(exact_matches) == 1
                and (not context.base_qualities or min(context.base_qualities) >= 20)):
            best = exact_matches[0]
            if geometry_level not in {"confirmed", "putative"}:
                return result(Call(reasons=("geometry_not_admissible",)), complete=True)
            # Exact identity is a separate assignment method, with no invented
            # runner-up likelihood or charge for a DP matrix that was not run.
            score = 0.
            for i, base_value in enumerate(observed):
                if not i & 255:
                    budget.check()
                quality = context.base_qualities[i] if context.base_qualities else None
                score += math.log(_emission(base_value, base_value, quality, context, policy))
            base["scores"] = {best: {"log_likelihood": score, "noise_edits": 0}}
            assignment = "target" if best == target_id else "reference" if best == "reference" else "other_allele"
            return result(Call(assignment, geometry_level, best, "exact_sequence"), complete=True,
                          log_odds=None, scoring="exact_identity")
        bands = {key: _band(observed, seq, context, policy, budget) for key, seq in candidates.items()}
        budget.charge([_band_cells(len(observed), len(seq), bands[key], budget) for key, seq in candidates.items()])
        # Python tuples/floats and two rolling rows, with generous overhead.
        width = max(min(len(candidates[key]) + 1, high - low + 1) for key, (low, high) in bands.items())
        reserved = 1024 * width + 128 * (len(observed) + 1)
        if reserved > DEFAULT_LIMITS.job_bytes:
            raise ResourceResult("budget_exceeded", "likelihood_row_bytes")
        RESERVATIONS.acquire(reserved, reserved >= DEFAULT_LIMITS.large_job_bytes, budget.deadline, budget.check)
        try:
            scores = {key: _score(observed, seq, context, policy, budget, bands[key]) for key, seq in candidates.items()}
        finally:
            RESERVATIONS.release(reserved, reserved >= DEFAULT_LIMITS.large_job_bytes)
    except ResourceResult as exc:
        return result(Call(reasons=(exc.reason,)), resource=exc.payload())
    base["scores"] = {key: {"log_likelihood": score, "noise_edits": noise} for key, (score, noise) in scores.items()}
    ordered = sorted(scores, key=lambda key: (-scores[key][0], key))
    best = ordered[0]
    margin = scores[best][0] - scores[ordered[1]][0] if len(ordered) > 1 else 0
    # Converted observations cannot distinguish a donor from its converted
    # allele merely because an assumed conversion rate favours the latter.
    indistinguishable = []
    if context.chemistry in {"CT", "GA"}:
        signature = _conversion_signature(candidates[best], context)
        indistinguishable = [key for key, sequence in candidates.items()
                             if key != best and _conversion_signature(sequence, context) == signature
                             and scores[key][1] <= scores[best][1]]
    exact_matches = [key for key, sequence in candidates.items() if sequence == observed]
    exact = (context.chemistry == "none" and len(exact_matches) == 1
             and (not context.base_qualities or min(context.base_qualities) >= 20))
    if (indistinguishable or margin < policy.min_log_odds) and not exact:
        return result(Call("ambiguous", "ambiguous", reasons=("competing_diagnostics",)),
                      complete=True, log_odds=margin, compatible_targets=[best, *indistinguishable])
    if scores[best][1] / max(1, len(observed), len(candidates[best])) > policy.max_noise_fraction:
        return result(Call(reasons=("poor_absolute_sequence_fit",)), complete=True, log_odds=margin)
    assignment = "target" if best == target_id else "reference" if best == "reference" else "other_allele"
    level = geometry_level if exact or policy.calibration_id else "putative"
    if geometry_level not in {"confirmed", "putative"}:
        return result(Call(reasons=("geometry_not_admissible",)), complete=True)
    return result(Call(assignment, level, best, "exact_sequence" if exact else "sequence_likelihood",
                       () if exact or policy.calibration_id else ("uncalibrated_likelihood_profile",)),
                  complete=True, log_odds=margin)
