"""Physical molecules shared by the datasets of one footprint-class run.

FiberHMM's class engines count each physical molecule once and refuse a run in
which the same molecule (PacBio movie/ZMW, otherwise the read name) appears in
two datasets. Two BAMs can share molecules when a sequencing run was assigned to
both samples. Other panels keep both copies unless the user declares the BAMs'
shared molecule provenance and turns on deduplication (services/lift/joint.py);
Find classes follows the same rule:

- undeclared sharing: refuse before loading, saying how many molecules and which
  datasets, instead of FiberHMM's error after the full load;
- declared sharing with deduplication on for every dataset holding the molecule:
  analyse each shared molecule once, in the first dataset by ID (the joint
  cohort's rule for native rows) among those whose copy the load keeps (a
  primary record at the run's minimum MAPQ; a supplementary or low-MAPQ copy
  never keeps the molecule from a usable one), and report how many copies were
  left out.
"""
from __future__ import annotations

from collections import defaultdict


def molecule_key(name) -> str:
    """FiberHMM's physical-molecule key of a read name (``fiberhmm.scan.identity``)."""
    try:
        from fiberhmm.scan.identity import molecule_key as fiberhmm_key
    except ImportError:  # older FiberHMM: the same normalisation
        name = str(name or '')
        pieces = name.split('/')
        return f'pacbio/{pieces[0]}/{pieces[1]}' if len(pieces) >= 3 and pieces[1].isdigit() else f'read/{name}'
    return fiberhmm_key(name)


#: chemistries whose loads read a ``cs`` tag as a joint duplex's source names (FiberHMM strand_mode 'daf')
DUPLEX_CHEMISTRIES = frozenset({'ddda', 'dddb'})


def _paths(dataset):
    paths = dataset['paths']
    return [paths] if isinstance(paths, str) else list(paths)


def shared_molecules(datasets, region, usable_out=None, minimum_mapq: int = 0) -> dict:
    """``{molecule key: {dataset_id: {read names}}}`` for molecules in two or more datasets.

    Secondary records are not molecules of their own; supplementary records are
    pieces of their molecule and count under its key; a DAF duplex read counts under its source reads' keys too. ``usable_out`` (a dict)
    receives ``{molecule key: {dataset ids holding a primary record at
    minimum_mapq}}`` (the copies the class load keeps)."""
    from services.remote_sources.opening import open_alignment_file
    from services.background_work import checkpoint
    from utils.chrom import resolve_reference_name

    holders = defaultdict(lambda: defaultdict(set))
    for dataset in datasets:
        dsid = dataset['dataset_id']
        # A DAF duplex read (``cs``: its two source reads) is also each source's molecule, as FiberHMM's
        # prepare_sources keys it (physical_source_names).
        duplex = str(dataset.get('chemistry') or '') in DUPLEX_CHEMISTRIES
        for path in _paths(dataset):
            with open_alignment_file(path, 'rb') as bam:
                chrom = resolve_reference_name(region['chrom'], bam.references)
                if chrom is None:
                    continue
                for i, read in enumerate(bam.fetch(chrom, max(0, region['start']), region['end'])):
                    if not i & 1023:
                        checkpoint()
                    if read.is_secondary or read.is_unmapped:
                        continue
                    keys = {molecule_key(read.query_name)}
                    if duplex and read.has_tag('cs'):
                        keys.update(molecule_key(n) for n in str(read.get_tag('cs')).split(';') if n)
                    usable = (usable_out is not None and not read.is_supplementary
                              and read.mapping_quality >= minimum_mapq)
                    for key in keys:
                        holders[key][dsid].add(read.query_name)
                        if usable:
                            usable_out.setdefault(key, set()).add(dsid)
    return {key: {d: names for d, names in by_ds.items()} for key, by_ds in holders.items() if len(by_ds) > 1}


def _declared(state, dsid):
    dataset = state.get_dataset(dsid)
    groups = {g for _, g in (getattr(dataset, 'molecule_groups', None) or []) if g}
    return groups, getattr(dataset, 'joint_dedup', 'off')


def _label(state, dsid):
    dataset = state.get_dataset(dsid)
    return str(getattr(dataset, 'label', None) or dsid)


def resolve_shared_molecules(state, datasets, region, minimum_mapq: int = 0):
    """``({dataset_id: read names to leave out}, warning or None)``; raises ValueError for undeclared sharing."""
    usable = {}
    shared = shared_molecules(datasets, region, usable, minimum_mapq)
    if not shared:
        return {}, None
    declared = {d['dataset_id']: _declared(state, d['dataset_id']) for d in datasets}
    undeclared, removed, pairs = defaultdict(int), defaultdict(set), defaultdict(int)
    for key, by_ds in shared.items():
        holders = sorted(by_ds)
        common = set.intersection(*(declared[d][0] for d in holders))
        if not common or any(declared[d][1] != 'by_molecule' for d in holders):
            undeclared[tuple(holders)] += 1
            continue
        # the first dataset by ID whose copy loads (else the first): the others leave theirs out
        keeper = next((d for d in holders if d in usable.get(key, ())), holders[0])
        pairs[(keeper, *[d for d in holders if d != keeper])] += 1
        for loser in holders:
            if loser != keeper:
                removed[loser] |= by_ds[loser]
    if undeclared:
        plural = lambda n: f"{n} molecule{'s' if n != 1 else ''}"
        detail = '; '.join(f"{plural(n)} in {' and '.join(_label(state, d) for d in ds)}" for ds, n in sorted(undeclared.items()))
        raise ValueError(
            f"The same molecules are in more than one dataset ({detail}). "
            'Find classes counts each molecule once, so it cannot treat one molecule as an observation in two datasets. '
            'These BAMs share reads (for example one sequencing run assigned to both samples). Remove the shared reads '
            'from one BAM, or give the BAMs the same Shared molecule provenance group with "Deduplicate shared '
            'molecules" on for each (Live-lift settings, Advanced), so every shared molecule is analysed once.')
    detail = '; '.join(f"{n} shared by {' and '.join(_label(state, d) for d in ds)}, kept in {_label(state, ds[0])}"
                       for ds, n in sorted(pairs.items()))
    total = sum(pairs.values())
    warning = (f"{total} molecule{'s' if total != 1 else ''} in more than one dataset analysed once "
               f"(deduplicated by molecule: {detail}).")
    return dict(removed), warning
