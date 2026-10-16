"""Exact primary class membership for Cart occupancy, independent of geometry rules."""
from services.oriented_regions import contains_chromosome


def _scored_from_molecules_table(path):
    """{dataset: {class: {unit ids}}} from the run's molecules.tsv.gz: one row per class x channel x molecule the
    lattice recaller scored (its per-class scoring population, members and non-members alike)."""
    import csv
    import gzip
    scored = {}
    with gzip.open(path, 'rt', newline='') as handle:
        for row in csv.DictReader(handle, delimiter='\t'):
            dataset = str(row['channel']).split('::', 1)[0]
            scored.setdefault(dataset, {}).setdefault(row['class_id'], set()).add(f"{dataset}::{row['unit_id']}")
    return scored


def _scored_from_rows(result):
    """The scoring population rebuilt from the result alone (an imported result without its run directory), as the
    recaller selects it: a channel's molecules whose alignment reaches past both flanks of the class's overlap group
    (every class box of the group widened by recaller.flank_bp). Alignment bounds stand in for the first/last site."""
    rows = (result.get('recaller') or {}).get('rows') or []
    flank = float(((result.get('manifest') or {}).get('parameters') or {}).get('recaller', {}).get('flank_bp', 0) or 0)
    windows = {}
    for row in rows:
        key = (row['group'], row['channel'])
        lo, hi = windows.get(key, (float('inf'), float('-inf')))
        windows[key] = (min(lo, float(row['L0']) - flank), max(hi, float(row['R1']) + flank))
    scored = {}
    for row in rows:
        dataset, strand = str(row['channel']).split('::', 1)
        data = (result.get('datasets') or {}).get(dataset) or {}
        pooled = str(data.get('chemistry', '')).startswith('hia5') or strand == 'pooled'
        lo, hi = windows[(row['group'], row['channel'])]
        target = scored.setdefault(dataset, {}).setdefault(row['class_id'], set())
        for unit in data.get('units', []):
            if not pooled and str(unit.get('strand', '')) != strand:
                continue
            start, end = unit.get('reference_start'), unit.get('reference_end')
            if isinstance(start, (int, float)) and isinstance(end, (int, float)) and start < lo and end >= hi:
                target.add(str(unit['unit_id']))
    return scored


def recaller_scored_units(job, dataset_id):
    """{class: {unit ids}} the lattice recaller scored each class on in ``dataset_id``; None for other engines.

    A molecule outside this population was not evaluated for the class (e.g. it ends before it), which is not the
    same as evaluated and absent. Cached on the job; a restored session supplies it as ``_scored_units``."""
    from pathlib import Path
    from services.consensus_workflow import _cr_mode, RECALLER_MODE
    result = job.get('result') or {}
    if _cr_mode(result) != RECALLER_MODE:
        return None
    if '_scored_units' not in job:
        table = Path(job.get('artifact_dir') or '') / 'molecules.tsv.gz'
        job['_scored_units'] = _scored_from_molecules_table(table) if job.get('artifact_dir') and table.is_file() else _scored_from_rows(result)
    return job['_scored_units'].get(dataset_id, {})


def class_occupancy(state, dataset_id, chrom, reads, groups, not_evaluated_out=None, unavailable_out=None):
    """Per Cart class group i: (members, eligible) read names. Eligible reads are the ones the class was evaluated
    on: identity-matched to the run and, for lattice recaller runs, in the class's scoring population. Matched reads
    the class was not evaluated on go to ``not_evaluated_out[i]`` when given; they are neither with nor without it.

    A class whose run is gone (a saved class after a restart) or belongs to another chromosome raises, unless
    ``unavailable_out`` is given: it then gets the reason and no eligible reads, and the other groups are unaffected."""
    from services.consensus_workflow import _session, _match_projection_unit, _visible, unit_strands, membership_records, saved_tier
    from services.consensus_curation import curated_records_for_unit
    memberships, eligible = {}, {}
    if not any(g.get('consensusStateId') for g in groups):
        return memberships, eligible
    jobs, lock = _session(state)
    with lock:
        for i, group in enumerate(groups):
            family = group.get('consensusStateId')
            if not family:
                continue
            memberships[i], eligible[i] = set(), set()
            if group.get('sourceDatasetId') != dataset_id:
                continue
            job = jobs.get(group.get('consensusJobId'))
            problem = None
            if not job or job.get('status') != 'complete':
                problem = 'Saved class analysis is unavailable; restore or rerun it before co-occupancy'
            elif not contains_chromosome(job['result'], dataset_id, chrom):
                problem = 'Saved class belongs to a different chromosome'
            if problem:
                if unavailable_out is None:
                    raise ValueError(problem)
                unavailable_out[i] = problem
                continue
            from services.consensus_workflow import membership_is_curated, stage_index
            # The stage the class was found in (manual classes: the final one),
            # not whichever stage is being looked at.
            manual = str(family).startswith('manual:')
            stage = job['result'].get('final_stage') if manual else group.get('consensusStage')
            index = stage_index(job, dataset_id, stage)
            # Final-stage membership is the curated one, as displayed.
            curated = manual or membership_is_curated(job, stage)
            if index is None:
                raise ValueError('Saved class dataset is unavailable in its analysis')
            # Each alignment is matched by its own identity, but results are
            # keyed by read name: a name whose alignments (e.g. the same QNAME
            # in two merged BAMs) disagree is ambiguous and left out, never
            # reported as one molecule carrying both answers.
            # A class saved for one DAF strand: molecules of the other strand are not eligible.
            source = group.get('consensusDatasetId') or dataset_id
            strand = group.get('consensusStrand')
            strands = unit_strands(job, source) if strand else None
            scored = None if manual else recaller_scored_units(job, source)
            scored = None if scored is None else scored.get(family, set())
            outcome, unscored = {}, set()
            projection = index
            if source != dataset_id:
                projection = {**index, 'projection_members': {name: [m for m in members if index.get('unit_sources', {}).get(m['unit_id']) == source]
                    for name, members in index['projection_members'].items()}}
            for read in reads:
                uid, _, _ = (_match_projection_unit(projection, read, chrom) if projection.get('unit_windows')
                             else _match_projection_unit(projection, read))
                if uid is None or (strands is not None and strands.get(uid) != strand):
                    continue
                rid = str(read['id'])
                if scored is not None and str(uid) not in scored:
                    unscored.add(rid)
                    continue
                records, native = membership_records(index, uid, family, job, saved_tier(group))
                if curated and native:
                    records = curated_records_for_unit(job, dataset_id, uid, records)
                member = any(
                    (record.get('manual_group_id') or record.get('family')) == family
                    for record in records
                    if not record.get('manual_ignored')
                    and record.get('classification_status') not in ('manual_ignored', 'provisional_unresolved'))
                outcome.setdefault(rid, set()).add(member)
            for rid, answers in outcome.items():
                if len(answers) != 1:
                    continue
                eligible[i].add(rid)
                if True in answers:
                    memberships[i].add(rid)
            if not_evaluated_out is not None:
                not_evaluated_out[i] = unscored - set(outcome)
    return memberships, eligible


def clustering_class_resolver(state, chrom):
    """Resolve saved Cart classes without treating their spans as matching rules."""
    from services.consensus_workflow import _session, _projection_identity, saved_tier
    revisions = {}
    cache = {}

    def resolve(read, group, region_start):
        dataset_id = read.get('_consensus_dataset_id') or str(read.get('id', '')).split('::', 1)[0]
        if dataset_id != group.get('sourceDatasetId'):
            return []
        name = str(read.get('_original_id', read.get('id', '')))
        job_id = group.get('consensusJobId')
        jobs, lock = _session(state)
        with lock:
            job = jobs.get(job_id)
            if not job or job.get('status') != 'complete':
                raise ValueError('Footprint class clustering requires its saved consensus analysis; restore or rerun it')
            revision = (id(job.get('index')), job.get('_curation', {}).get('revision', 0))
            if job_id in revisions and revisions[job_id] != revision:
                raise ValueError('Class assignments changed during clustering; run clustering again')
            revisions[job_id] = revision
            # The stage is part of the class: one family can hold a read in one
            # stage and not in another.
            key = (dataset_id, name, group.get('consensusStateId'), group.get('consensusStage'), group.get('consensusStrand'), saved_tier(group), job_id,
                   repr(sorted(_projection_identity(read).items())), read.get('_consensus_chrom', chrom))
            if key not in cache:
                unscored = {}
                member, eligible = class_occupancy(state, dataset_id,
                    read.get('_consensus_chrom', chrom), [{**read, 'id': name}], [group], not_evaluated_out=unscored)
                if name not in eligible[0] and group.get('consensusStrand'):
                    eligible[0].add(name)   # a molecule of the other strand: not a member of a one-strand class
                if name in unscored.get(0, ()):
                    # Matched but not evaluated for this class (e.g. it ends before it): a binary clustering feature
                    # can only say it isn't a member.
                    eligible[0].add(name)
                if name not in eligible[0]:
                    raise ValueError('Some clustering reads are absent or ambiguous in the saved class analysis; rerun the class analysis for this read scope')
                cache[key] = name in member[0]
        if not cache[key]:
            return []
        left, right = group.get('referenceAbsStart'), group.get('referenceAbsEnd')
        if left is None or right is None or right <= left:
            raise ValueError('Footprint class needs its saved reference span; add it to the Cart again')
        # A fixed support span makes the feature binary class presence, not
        # the size/edge variation of its member calls. Native calls are untouched.
        return [(left - region_start, right - region_start, 1.0)]
    return resolve
