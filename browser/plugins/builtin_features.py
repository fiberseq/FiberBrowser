"""Core features that register through the plugin-pack extension points (plugins/packs.py, ARCHITECTURE.md).

Every build has them: ``load_packs`` registers this module first, as a built-in (never listed as a pack, so it sets no
flavour and marks nothing in sessions). Their routers are core's (routers/registry.py) and so are their allowlist
entries; what goes through the hooks here is the part that lives in sessions:

- alt-allele (insert-expanded) datasets: an insertion's carriers re-aligned onto its alternate allele
  (services/alt_allele.py). A session stores their definition; they are rebuilt (or their built files reused) once
  the source datasets and references are back, and their contig is named for the insertion however it is attached.

Everything heavy is imported lazily, inside the hooks.
"""
from __future__ import annotations

from plugins.packs import DatasetRestorer, PackAPI


def _adopt(state, dataset):
    # A built alt allele's BAM knows its definition again.
    from services.alt_allele import adopt
    adopt(state, dataset)


def _alt_entry(dataset):
    from services.alt_allele import session_entry
    entry = session_entry(dataset)
    return {"alt_allele": entry} if entry else None


def _alt_restore(state, entry):
    from services.alt_allele import restore_from_session
    return restore_from_session(state, entry)


def _alt_reattach(state):
    from services.alt_allele import reattach
    reattach(state)


def _fasta_context(ctx, fasta_path):
    from services.alt_allele import describe_fasta_context
    describe_fasta_context(ctx, fasta_path)


def register(api: PackAPI) -> None:
    # Alt-allele datasets (an insertion's carriers on its alternate allele). Entries an older lab build marked
    # ``"pack": "lab"`` are claimed here too (the restorer is asked before the marker).
    api.on_dataset_opened(_adopt)
    api.dataset_session_entry(_alt_entry)
    api.dataset_restorer(DatasetRestorer(owns=lambda entry: bool(entry.get("alt_allele")), restore=_alt_restore,
                                         finish=_alt_reattach, label="alt allele"))
    api.fasta_context(_fasta_context)
    # Sessions saved before references were marked: an alt allele's contig is rebuilt with its dataset.
    api.session_reference_filter(lambda kind, key, source: kind == "panel_genome" and key.startswith("fasta:alt_"))
