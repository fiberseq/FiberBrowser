"""Job-level explicit shared-molecule overlap and optional deduplication."""
import os
from collections import defaultdict


def _escape(value) -> str:
    return str(value).replace("\\", "\\\\").replace("|", "\\|")


def molecule_key(group, qname) -> str:
    """``group|qname``, with ``\\`` and ``|`` escaped inside either part, so two
    different (group, qname) pairs never share a key. Names without those
    characters keep the key they always had."""
    return f"{_escape(group)}|{_escape(qname)}"


def _real(path) -> str:
    try:
        return os.path.realpath(os.path.expanduser(str(path)))
    except (OSError, ValueError, TypeError):
        return str(path)


def group_for(groups: dict, source_path=None, library_id=None):
    """A record's provenance group. ``groups`` keys are the paths the user named
    (possibly relative or a symlink); records carry the resolved file path
    (``library_id``) and sometimes the raw one, so both sides are resolved."""
    if not groups:
        return None
    for key in (source_path, library_id):
        if key and groups.get(key):
            return groups[key]
    resolved = {_real(p): g for p, g in groups.items() if g}
    for key in (source_path, library_id):
        if key and resolved.get(_real(key)):
            return resolved[_real(key)]
    return None


def molecule_identity(dataset, read):
    ll = read.get("live_lift")
    if ll:
        return ll.get("molecule")
    groups = dict(getattr(dataset, "molecule_groups", []) or [])
    group = group_for(groups, read.get("source_path"), read.get("library_id"))
    if not group:
        return None
    return molecule_key(group, read.get('_display_id') or read.get('_original_id') or read['id'])


def joint_dedup_datasets(state, dataset_ids):
    """The datasets whose rows ``prepare_joint_cohort`` may drop: those sharing a provenance group with another of
    ``dataset_ids`` when all of them deduplicate by molecule (empty otherwise). Aggregate shortcuts (display or
    broad-cache counts) must not stand in for their rows."""
    groups_of, policies = {}, {}
    for ds_id in dataset_ids:
        dataset = state.get_dataset(ds_id)
        if dataset is None:
            continue
        config = getattr(dataset, "live_lift", None)
        settings = config.settings if config else None
        groups_of[ds_id] = {g for g in dict(settings.molecule_groups if settings else getattr(dataset, "molecule_groups", []) or []).values() if g}
        policies[ds_id] = settings.joint_dedup if settings else getattr(dataset, "joint_dedup", "off")
    participating = {d for d, gs in groups_of.items() if any(gs & og for o, og in groups_of.items() if o != d)}
    if participating and all(policies[d] == "by_molecule" for d in participating):
        return participating
    return set()


def prepare_joint_cohort(state, reads, dataset_ids=None):
    """Resolve policy only among datasets whose provenance groups are shared.

    Keep both copies by default. Unlabelled native BAMs never share molecules.
    A winner is native before lifted, dataset ID, then cohort ID, independent
    of window enumeration. Exactly one row wins for each shared molecule.
    """
    from services.background_work import checkpoint
    from services.lift.capability import is_lifted
    by_molecule = defaultdict(list)
    datasets_by_group = defaultdict(set)
    policies = {}
    dataset_ids = list(dataset_ids) if dataset_ids is not None else sorted({r.get("_consensus_dataset_id") for r in reads if r.get("_consensus_dataset_id")})
    datasets = {d: state.get_dataset(d) for d in dataset_ids}
    for ds_id, dataset in datasets.items():
        if dataset is None:
            continue
        config = getattr(dataset, "live_lift", None)
        settings = config.settings if config else None
        groups = dict(settings.molecule_groups if settings else getattr(dataset, "molecule_groups", []) or [])
        for group in groups.values():
            if group:
                datasets_by_group[group].add(ds_id)
        policies[ds_id] = settings.joint_dedup if settings else getattr(dataset, "joint_dedup", "off")
    for i, r in enumerate(reads):
        if i % 256 == 0:
            checkpoint()
        ds_id = r.get("_consensus_dataset_id")
        dataset = datasets.get(ds_id)
        if dataset is None:
            continue
        molecule = molecule_identity(dataset, r)
        if molecule:
            by_molecule[molecule].append((ds_id, r))
    participating = {d for ds in datasets_by_group.values() if len(ds) > 1 for d in ds}
    shared = {m: rs for m, rs in by_molecule.items() if len({d for d, _ in rs}) > 1}
    policy = "by_molecule" if participating and all(policies[d] == "by_molecule" for d in participating) else "off"
    removed = set()
    if policy == "by_molecule":
        for entries in shared.values():
            winner = min(entries, key=lambda e: (is_lifted(state.get_dataset(e[0])), e[0],
                                                 e[1].get("_original_id", e[1]["id"]), e[1]["id"]))[1]
            removed.update(id(r) for _, r in entries if r is not winner)
    pairs = defaultdict(int)
    for entries in shared.values():
        ds = sorted({d for d, _ in entries})
        for i, a in enumerate(ds):
            for b in ds[i+1:]:
                pairs[(a, b)] += 1
    report = dict(policy=policy, shared_molecules=len(shared), removed_rows=len(removed), input_rows=len(reads),
                  rows=len(reads) - len(removed), identity="provenance group + QNAME",
                  pairs=[dict(datasets=list(pair), molecules=n) for pair, n in sorted(pairs.items())])
    kept = [r for r in reads if id(r) not in removed]
    # Seeded fitting and balanced sampling both depend on row order, even
    # when every copy is retained. The panel prefix breaks ties across views.
    kept.sort(key=lambda r: (is_lifted(datasets.get(r.get("_consensus_dataset_id"))),
                             r.get("_consensus_dataset_id", ""), r.get("_original_id", r["id"]), r["id"]))
    return kept, report
