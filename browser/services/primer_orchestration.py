"""Shared primer-design orchestration helpers."""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

from services.primer_config import blast_db_exists, blast_install_message, resolve_blast_db_for_genome


@dataclass(frozen=True)
class PrimerRuntimeConfig:
    fasta_path: str
    blast_db_path: str


def resolve_primer_runtime_config(
    state,
    *,
    require_blastn: bool = True,
    missing_fasta_message: str = "FASTA file not configured.",
    missing_blast_message: str = "BLAST database not configured.",
) -> tuple[Optional[PrimerRuntimeConfig], Optional[dict]]:
    """Resolve FASTA + BLAST DB config before a primer design run.

    Primer routes accept either explicit primer config or the browser's loaded
    genome FASTA. Centralizing this keeps standard PCR, DAF-C, and 4C behavior
    consistent as the UI adds setup flows.
    """
    # The FASTA/database pair is read, switched if needed and validated under the reference locks (a genome load
    # in progress finishes first), and the run keeps this pair whatever is loaded meanwhile.
    from services.genome_loading import reference_write_lock
    with reference_write_lock(state):
        fasta_path = getattr(state, 'primer_fasta', None) or getattr(state, 'fasta_path', None)
        if not fasta_path:
            return None, {"success": False, "message": missing_fasta_message}
        if not os.path.isfile(fasta_path):
            return None, {"success": False, "message": f"FASTA file not found: {fasta_path}"}
        # primer_fasta holds only an explicit override: persisting the automatic
        # choice pinned design to this reference after another genome is loaded.
        blast_db_path = getattr(state, 'primer_blast_db', None)
        if not blast_db_path:
            return None, {"success": False, "message": missing_blast_message}
        resolved_db, db_error = resolve_blast_db_for_genome(state, wait=True)
        if db_error or not resolved_db:
            return None, {"success": False, "message": db_error or missing_blast_message}
        blast_db_path = resolved_db
        if not blast_db_exists(blast_db_path):
            from services.primer_config import blast_db_missing_message
            return None, {"success": False, "message": blast_db_missing_message(blast_db_path)}
        from services.primer_config import set_primer_paths
        set_primer_paths(state, blast_db=blast_db_path)

    from services.external_tools import tool_path
    if require_blastn and tool_path('blastn') is None:
        return None, {
            "success": False,
            "message": blast_install_message(),
            "missing_dependency": True,
            "dependency": "blastn",
        }

    return PrimerRuntimeConfig(fasta_path=fasta_path, blast_db_path=blast_db_path), None
