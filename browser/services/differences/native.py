"""Independent native geometry adapter. No map or lift-service dependency.

Merged-file name folding remains an explicit legacy provenance assumption.
The richer producer can supply qualified memberships without changing it.
"""
from dataclasses import asdict

from .calls import Call, MembershipIndex, MoleculeId, Representation, reconcile_representations
from .identity import content_id
from .model import AlleleTarget, Geometry, ResultScope, SCHEMA_VERSION, Span


def native_geometry_envelope(by_name, entries, *, dataset_id, chrom, start, end, t, ref, length,
                             target_end=None, policy=None, include_duplicates=False):
    geometry = Geometry(Span(chrom, ref, target_end if target_end is not None else ref + length if t == "D" else ref),
                        length if t == "I" else 0, "insertion" if t == "I" and target_end in (None, ref) else "deletion" if t == "D" else "replacement")
    target = AlleleTarget(content_id("frozen-geometry:v1", [dataset_id, geometry.payload()]), 1, "geometry",
                         "unresolved_reference:" + dataset_id, geometry)
    index, calls = MembershipIndex(), {}
    for row in entries:
        if row['id'] not in by_name or (row.get('duplicate') and not include_duplicates):
            continue
        molecule = MoleculeId("legacy_merged_dataset", dataset_id, row["id"])
        index.add(dataset_id, row.get("row_id", row["id"]), molecule, analysis_id=row.get("analysis_id"))
    for name, entry in by_name.items():
        molecule = MoleculeId("legacy_merged_dataset", dataset_id, name)
        evidence = entry.get("evidence") or {}
        # The exact axis remains unresolved even for confirmed CIGAR geometry.
        call = Call("unknown", evidence.get("level"), method="geometry_only",
                    reasons=("sequence_not_assessed",))
        reconciled = reconcile_representations([Representation("native", "native", call)], scope="native_only")
        calls[molecule.key] = {**reconciled, "molecule_id": asdict(molecule),
                               "target_id": target.target_id, "target_revision": target.revision,
                               "geometry_group": entry["allele"], "geometry_evidence": evidence,
                               "exact_assignment": "unknown"}
    scope = ResultScope("native_only", target.reference_id,
                        tiles=({"core": [start, end], "halo": None, "discovery": "loaded"},),
                        unresolved={"sequence": len(calls), "reference_identity": 1})
    return {"schema_version": SCHEMA_VERSION, "target": asdict(target), "scope": asdict(scope),
            "calls_by_molecule": calls, "membership": index.payload(),
            "policy": policy or {}, "identity_assumption": "legacy_merged_dataset",
            "geometry_counts": [sum(c["geometry_group"] == n for c in calls.values()) for n in range(3)],
            "exact_counts": {"target": 0, "reference": 0, "unknown": len(calls)}}


def qualified_display_rows(rows, dataset):
    """Disambiguate duplicate names across explicitly declared native libraries.

    Single-library datasets retain their existing name-based display contract. This
    adapter uses already decoded SAM digests and never reopens BAM records.
    """
    from pathlib import Path
    labels = dict(getattr(dataset, 'molecule_groups', ()) or ())
    if not labels:
        return rows
    groups = {str(Path(path).expanduser().resolve()): labels.get(path) or f'{dataset.id}#{i}'
              for i, path in enumerate(dataset.paths)}
    if len(set(groups.values())) < 2:
        return rows
    result = []
    for row in rows:
        library = groups.get(row.get('library_id'))
        if library is None or not row.get('record_sha256'):
            result.append(row)
            continue
        molecule = MoleculeId('declared_source_library', library, row['id'])
        identity = content_id('alignment-record:v1', [molecule.key, row['record_sha256'], row.get('alignment_occurrence', 0)])
        result.append({**row, 'analysis_id': identity, '_display_id': row['id']})
    return result
