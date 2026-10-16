"""Shared validation and messaging for primer BLAST results."""
from __future__ import annotations

from typing import Optional


def blast_filter_label(check_three_prime_specificity: bool) -> str:
    if check_three_prime_specificity:
        return "one home hit + no off-target + no 3'-end threat"
    return "one home hit + no off-target (3'-end check OFF)"


def blast_execution_error(hit_counts: dict, stderr_text: str) -> Optional[str]:
    """Return a user-facing BLAST subprocess error, if the run failed."""
    if not hit_counts and stderr_text:
        return f"BLAST failed. {stderr_text}"
    return None


def no_home_hit_error(hit_counts: dict) -> Optional[str]:
    """Return a DB mismatch hint when no primer has a home hit."""
    if hit_counts and not any(c.get("on_target", 0) > 0 for c in hit_counts.values()):
        return "BLAST found no home hits - check that BLAST database matches the reference genome."
    return None


def validate_shared_blast_result(
    passing: set,
    hit_counts: dict,
    stderr_text: str,
    *,
    no_pass_message: str = "No primers passed BLAST specificity check",
) -> Optional[dict]:
    """Validate one pooled BLAST result for DAF-C/4C-style workflows."""
    message = blast_execution_error(hit_counts, stderr_text) or no_home_hit_error(hit_counts)
    if message:
        return {
            "progress": {"active": False, "stage": "error", "progress": 0, "message": ""},
            "response": {"success": False, "message": message},
        }
    if not passing:
        return {
            "progress": {"active": False, "stage": "done", "progress": 100, "message": ""},
            "response": {"success": False, "message": no_pass_message},
        }
    return None


def validate_stranded_blast_execution(*results: tuple[dict, str]) -> Optional[dict]:
    """Validate standard PCR's independent fwd/rev BLAST subprocesses."""
    messages = []
    for hit_counts, stderr_text in results:
        message = blast_execution_error(hit_counts, stderr_text)
        if message:
            messages.append(message)
    if not messages:
        return None
    return {
        "progress": {"active": False, "stage": "error", "progress": 0, "message": ""},
        "response": {"success": False, "message": " ".join(messages)},
    }


def validate_stranded_blast_passing(
    forward_passing: set,
    reverse_passing: set,
) -> Optional[dict]:
    if forward_passing and reverse_passing:
        return None
    message = (
        "No primers passed BLAST specificity check "
        f"({len(forward_passing)} fwd, {len(reverse_passing)} rev unique). "
        "Try adjusting parameters."
    )
    return {
        "progress": {"active": False, "stage": "done", "progress": 100, "message": ""},
        "response": {"success": False, "message": message},
    }
