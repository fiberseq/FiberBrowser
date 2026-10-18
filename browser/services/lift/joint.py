"""Job-level explicit shared-molecule overlap and optional deduplication."""
from collections import defaultdict


def molecule_identity(dataset, read):
    ll = read.get("live_lift")
    if ll:
        return ll.get("molecule")
    groups = dict(getattr(dataset, "molecule_groups", []) or [])
    group = groups.get(read.get("source_path")) or groups.get(read.get("library_id"))
    if not group:
        return None
    return f"{group}|{read.get('_display_id') or read.get('_original_id') or read['id']}"


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
    if policy == "by_molecule":
        kept.sort(key=lambda r: (is_lifted(datasets.get(r.get("_consensus_dataset_id"))),
                                 r.get("_consensus_dataset_id", ""), r.get("_original_id", r["id"]), r["id"]))
    return kept, report
