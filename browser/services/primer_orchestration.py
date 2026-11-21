"""Shared primer-design orchestration helpers."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Iterable, Optional

from services.primer_config import blast_db_exists, blast_install_message, resolve_blast_db_for_genome

# Whether the primer template is expected in the BLAST database (``template_in_db``):
#   'auto'  - a contig of the FASTA the database was built from is (one home hit expected); a loaded
#             plasmid/custom sequence is not (no hit expected: every genome hit is off-target);
#   'yes'   - always expect exactly one home hit (a database that includes the plasmid);
#   'no'    - never: every hit in the database counts against a primer.
TEMPLATE_IN_DB_MODES = ('auto', 'yes', 'no')


@dataclass(frozen=True)
class PrimerRuntimeConfig:
    fasta_path: Optional[str]
    blast_db_path: str
    # Loaded plasmid/custom sequences among the template contigs: read from memory, in no FASTA.
    sequence_templates: frozenset = field(default_factory=frozenset)
    template_in_db: str = 'auto'
    # The database plasmid/custom templates are checked against (the user's chosen background); None: the
    # same as blast_db_path. Genome contigs always use blast_db_path (the genome's database).
    sequence_blast_db_path: Optional[str] = None

    def expects_home_hit(self, chrom: Optional[str]) -> bool:
        """Whether a primer on ``chrom`` should have its one home hit in the BLAST database."""
        if self.template_in_db == 'yes':
            return True
        if self.template_in_db == 'no':
            return False
        return chrom not in self.sequence_templates

    def blast_db_for(self, chrom: Optional[str]) -> str:
        """The database primers on ``chrom`` are BLASTed against."""
        if self.expects_home_hit(chrom):
            return self.blast_db_path
        return self.sequence_blast_db_path or self.blast_db_path


def _sequence_templates(state, chroms: Iterable[Optional[str]], fasta_path: Optional[str]) -> tuple[set, set]:
    """(loaded plasmid/custom contigs among chroms, contigs that must come from the FASTA).

    Names resolve as design resolves them (``resolve_template_chrom``): a plasmid by its exact name only,
    so plasmid ``1`` beside genome ``chr1`` is a plasmid and ``chr1`` the genome contig."""
    from services.primer_reference import resolve_template_chrom, supplemental_sequences
    file_chroms: set = set()
    if fasta_path:
        try:
            from services.primer_reference import _get_file_interface
            file_chroms = set(_get_file_interface(state, fasta_path)[2])
        except Exception:
            file_chroms = set()
    plasmids = set(supplemental_sequences(state))
    sequences, from_file = set(), set()
    for chrom in chroms:
        if not chrom:
            continue
        key = resolve_template_chrom(chrom, file_chroms | plasmids, state)
        if key is not None and key in plasmids:
            sequences.add(key)
        else:
            from_file.add(key or chrom)
    return sequences, from_file


def resolve_primer_runtime_config(
    state,
    *,
    chroms: Iterable[Optional[str]] = (),
    template_in_db: str = 'auto',
    require_blastn: bool = True,
    missing_fasta_message: str = "FASTA file not configured.",
    missing_blast_message: str = "BLAST database not configured.",
) -> tuple[Optional[PrimerRuntimeConfig], Optional[dict]]:
    """Resolve FASTA + BLAST DB config before a primer design run.

    Primer routes accept either explicit primer config or the browser's loaded
    genome FASTA. Centralizing this keeps standard PCR, DAF-C, and 4C behavior
    consistent as the UI adds setup flows.

    ``chroms`` are the run's template contigs. A loaded plasmid map's contig (a SnapGene .dna, say) is
    designed on from memory and BLASTed against the database the user chose (the loaded genome's, for
    off-target hits): no FASTA file is needed for it and no database is ever demanded or built from it.
    """
    if template_in_db not in TEMPLATE_IN_DB_MODES:
        return None, {"success": False,
                      "message": f"template_in_db must be one of {', '.join(TEMPLATE_IN_DB_MODES)}, not {template_in_db!r}"}
    # The FASTA/database pair is read, switched if needed and validated under the reference locks (a genome load
    # in progress finishes first), and the run keeps this pair whatever is loaded meanwhile.
    from services.genome_loading import reference_write_lock
    from services.primer_config import local_primer_fasta, primer_fasta_setting
    with reference_write_lock(state):
        setting = primer_fasta_setting(state)
        fasta_path = local_primer_fasta(state)
        sequences, from_file = _sequence_templates(state, chroms, fasta_path)
        only_sequences = bool(sequences) and not from_file
        if not only_sequences:
            if not setting:
                return None, {"success": False, "message": missing_fasta_message}
            if not fasta_path:
                return None, {"success": False, "message": f"FASTA file not found: {setting}"}
        # primer_fasta holds only an explicit override: persisting the automatic
        # choice pinned design to this reference after another genome is loaded.
        blast_db_path = getattr(state, 'primer_blast_db', None)
        if not blast_db_path:
            if only_sequences:
                names = ', '.join(sorted(sequences))
                return None, {"success": False, "message": (
                    f"No BLAST database chosen. Primers on {names} are checked for off-target binding against a "
                    "genome BLAST database: choose yours (for example dm6) with Browse in the Primer panel. "
                    "No database of the plasmid itself is needed.")}
            return None, {"success": False, "message": missing_blast_message}
        sequence_db = None
        if sequences and from_file:
            # 3C across a genome locus and a plasmid map: the plasmid locus is checked against the chosen
            # background, the genome locus against the genome's database (resolved below).
            from services.primer_config import blast_db_missing_message
            if not blast_db_exists(blast_db_path):
                return None, {"success": False, "message": blast_db_missing_message(blast_db_path)}
            sequence_db = blast_db_path
        if only_sequences:
            # The template is in no FASTA and no database: the chosen database is the background primers are
            # checked against, whatever genome it is, so it is not matched to a reference.
            if not blast_db_exists(blast_db_path):
                from services.primer_config import blast_db_missing_message
                return None, {"success": False, "message": blast_db_missing_message(blast_db_path)}
        else:
            resolved_db, db_error = resolve_blast_db_for_genome(state, wait=True)
            if db_error or not resolved_db:
                return None, {"success": False, "message": db_error or missing_blast_message}
            # A switch to the genome's database was published by resolve_blast_db_for_genome; a database the
            # user chose (pinned) stays configured and its genome-matching sibling serves this run only.
            blast_db_path = resolved_db
            if not blast_db_exists(blast_db_path):
                from services.primer_config import blast_db_missing_message
                return None, {"success": False, "message": blast_db_missing_message(blast_db_path)}

    from services.external_tools import tool_path
    if require_blastn and tool_path('blastn') is None:
        return None, {
            "success": False,
            "message": blast_install_message(),
            "missing_dependency": True,
            "dependency": "blastn",
        }

    return PrimerRuntimeConfig(fasta_path=fasta_path, blast_db_path=blast_db_path,
                               sequence_templates=frozenset(sequences), template_in_db=template_in_db,
                               sequence_blast_db_path=sequence_db), None
