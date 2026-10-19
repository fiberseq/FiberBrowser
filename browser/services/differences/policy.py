"""Versioned, bounded joint-path search policy; exhaustion is evidence."""
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class SearchPolicy:
    version: str = "hypothesis:v1"
    max_hypotheses: int = 64
    max_path_states: int = 4096
    max_transitions: int = 16384
    max_compound_members: int = 32
    max_compound_window_bp: int = 10_000
    max_reconstructed_bp: int = 100_000

    def __post_init__(self):
        if any(type(v) is not int or v < 1 for k, v in asdict(self).items() if k != "version"):
            raise ValueError("search limits must be positive integers")


class SearchBudget:
    def __init__(self, policy=SearchPolicy()):
        self.policy = policy
        self.explored = {"hypotheses": 0, "path_states": 0, "transitions": 0}
        self.pruned = dict.fromkeys(self.explored, 0)
        self.unexplored = []

    def admit(self, kind, *, ownership="coequal"):
        limit = getattr(self.policy, "max_" + kind)
        if self.explored[kind] >= limit:
            self.pruned[kind] += 1
            self.unexplored.append({"outcome": "unexplored", "ownership": ownership,
                                    "reason": kind + "_cap"})
            return False
        self.explored[kind] += 1
        return True

    def payload(self):
        return {"search_complete": not self.unexplored, "policy": asdict(self.policy),
                "explored": dict(self.explored), "pruned": dict(self.pruned),
                "unexplored": list(self.unexplored)}
